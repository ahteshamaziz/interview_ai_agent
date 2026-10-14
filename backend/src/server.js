require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const Anthropic = require('@anthropic-ai/sdk');
const { connectDb } = require('./db');
const { initEmbeddings } = require('./embeddings');
const { lookupAnswer, lookupExactAnswer, saveAnswer, backfillEmbeddings } = require('./knowledgeBase');
const {
  getSessionProfile,
  clearSession,
  startSession,
  formatSessionForPrompt,
} = require('./session');

const PORT = process.env.PORT || 8787;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DG_ENDPOINTING_MS = Number(process.env.DG_ENDPOINTING_MS || 1500);
// Two-tier silence debounce: finalize once the utterance sounds complete,
// but keep waiting through thinking pauses. Interviewers often pause mid-
// question — answering on those fragments breaks the Q&A flow.
const UTTERANCE_SILENCE_MS = Number(process.env.UTTERANCE_SILENCE_MS || 1800);
const UTTERANCE_MAX_PAUSE_MS = Number(process.env.UTTERANCE_MAX_PAUSE_MS || 4500);
const MIN_UTTERANCE_CHARS = Number(process.env.MIN_UTTERANCE_CHARS || 12);

if (!DEEPGRAM_API_KEY) throw new Error('Missing DEEPGRAM_API_KEY in backend/.env');
if (!ANTHROPIC_API_KEY) throw new Error('Missing ANTHROPIC_API_KEY in backend/.env');

const deepgram = createClient(DEEPGRAM_API_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Balanced: detailed enough for interviews, short enough for Haiku to stay fast.
const SYSTEM_PROMPT_BASE = `You are a sharp interview co-pilot. Give a clear spoken answer the candidate can use.
No preamble ("Sure", "Here's an answer") — answer content only.

Target ~200–350 words. Be useful, not an essay.

If earlier turns are in the conversation, treat short or referential questions
("give an example", "why?", "what about that", "can you elaborate") as follow-ups
to that context. Do not ask the candidate to restate the prior question.

Structure:
1. Direct answer (1–2 sentences)
2. Key points as bullets (4–6 bullets)
3. One short real-world / spoken example
4. If technical: a small code snippet (≤15 lines) + 1–2 trade-offs
5. 2 likely follow-up questions with one-line replies

Prefer bullets. Skip fluff.`;

const DEFAULT_LANGUAGE_RULE = `IMPORTANT: For every coding / technical question, write all code examples in JavaScript only
(Node.js-style when backend context fits). Do not use Python, Java, C++, TypeScript-only syntax,
or other languages unless the question explicitly asks for that language.`;

function buildSystemPrompt() {
  const profile = getSessionProfile();
  if (!profile) {
    return `${SYSTEM_PROMPT_BASE}\n\n${DEFAULT_LANGUAGE_RULE}`;
  }
  return `${SYSTEM_PROMPT_BASE}\n\n${formatSessionForPrompt(profile)}`;
}

const ANSWER_MODEL = process.env.ANSWER_MODEL || 'claude-haiku-4-5-20251001';
const EXTRACT_MODEL = process.env.EXTRACT_MODEL || 'claude-haiku-4-5-20251001';
const ANSWER_MAX_TOKENS = Number(process.env.ANSWER_MAX_TOKENS || 900);
const MAX_HISTORY_TURNS = Number(process.env.MAX_HISTORY_TURNS || 5);
const HISTORY_ANSWER_CHARS = Number(process.env.HISTORY_ANSWER_CHARS || 900);

// Single-user local session memory — survives listen stop/start and temp WS reconnects.
let conversationHistory = [];

function truncateForHistory(answer) {
  const a = String(answer || '').trim();
  if (a.length <= HISTORY_ANSWER_CHARS) return a;
  return `${a.slice(0, HISTORY_ANSWER_CHARS)}…`;
}

function rememberTurn(question, answer) {
  const q = String(question || '').trim();
  const a = truncateForHistory(answer);
  if (!q || !a) return;
  conversationHistory.push({ question: q, answer: a });
  if (conversationHistory.length > MAX_HISTORY_TURNS) {
    conversationHistory = conversationHistory.slice(-MAX_HISTORY_TURNS);
  }
  console.log(`[history] ${conversationHistory.length} turn(s) kept`);
}

function clearConversationHistory() {
  conversationHistory = [];
  console.log('[history] cleared');
}

function looksLikeFollowUp(text) {
  if (conversationHistory.length === 0) return false;
  const t = String(text || '').trim();
  if (!t) return false;
  const wordCount = t.split(/\s+/).filter(Boolean).length;

  if (
    /\b(that|this|it|those|these|them|previous|above|same|earlier|the example|elaborate|expand on|more detail|go deeper|what about|how about|why is that|you mentioned|your answer|follow[- ]?up)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/^(and|but|so|also|okay|ok|yes|no|right|continue|go on)\b/i.test(t)) return true;

  // Short prompts without a fresh topic opener are usually follow-ups.
  if (
    wordCount <= 5 &&
    !/^(what is|what are|what does|define|explain|describe|tell me about|walk me through)\b/i.test(t)
  ) {
    return true;
  }
  return false;
}

async function generateAnswer(transcriptText, onDelta, history = conversationHistory) {
  const t0 = Date.now();
  const messages = [];
  for (const turn of history) {
    messages.push({ role: 'user', content: turn.question });
    messages.push({ role: 'assistant', content: turn.answer });
  }
  messages.push({ role: 'user', content: transcriptText });

  const stream = anthropic.messages.stream({
    model: ANSWER_MODEL,
    max_tokens: ANSWER_MAX_TOKENS,
    system: buildSystemPrompt(),
    messages,
  });

  let full = '';
  let firstTokenAt = null;
  stream.on('text', (text) => {
    if (firstTokenAt == null) {
      firstTokenAt = Date.now();
      console.log(`[claude] first token in ${firstTokenAt - t0}ms`);
    }
    full += text;
    if (onDelta) onDelta(text);
  });

  await stream.finalMessage();
  console.log(
    `[claude] complete in ${Date.now() - t0}ms (${full.length} chars, history=${history.length})`,
  );
  return full;
}

async function resolveAnswer(question, onDelta) {
  const t0 = Date.now();
  const followUp = looksLikeFollowUp(question);
  // Session-specific answers must not reuse the generic KB cache.
  const useCache = !followUp && !getSessionProfile();

  // Follow-ups must not hit the standalone KB cache ("give an example" ≠ closures).
  if (useCache) {
    const cached = await lookupExactAnswer(question);
    if (cached) {
      console.log(`[kb] cache hit (${cached.matchType}) in ${Date.now() - t0}ms: "${question}"`);
      rememberTurn(question, cached.answer);
      return {
        answer: cached.answer,
        source: 'cache',
        matchType: cached.matchType,
        matchedQuestion: cached.matchedQuestion,
        followUp: false,
      };
    }
  } else if (followUp) {
    console.log(`[history] follow-up with ${conversationHistory.length} prior turn(s): "${question}"`);
  }

  console.log(`[kb] cache miss, calling model: "${question}"`);
  // Snapshot history before this turn so we don't include the current Q yet.
  const priorHistory = conversationHistory.slice();
  const answer = await generateAnswer(question, onDelta, priorHistory);
  rememberTurn(question, answer);
  if (useCache) {
    saveAnswer(question, answer).catch((err) =>
      console.warn('[kb] background save failed:', err.message),
    );
  }
  console.log(`[resolve] model answer ready in ${Date.now() - t0}ms`);
  return { answer, source: 'model', followUp };
}

// Shared WS answer path for spoken + typed questions (keeps history in sync).
async function streamAnswerToClient(send, question) {
  const followUp = looksLikeFollowUp(question);
  const useCache = !followUp && !getSessionProfile();

  if (useCache) {
    const cached = await lookupExactAnswer(question);
    if (cached) {
      rememberTurn(question, cached.answer);
      console.log(`[kb] cache hit (${cached.matchType}): "${question}"`);
      send({
        type: 'answer',
        question,
        answer: cached.answer,
        source: 'cache',
        matchType: cached.matchType,
        matchedQuestion: cached.matchedQuestion,
      });
      return;
    }
  } else if (followUp) {
    console.log(`[history] follow-up with ${conversationHistory.length} prior turn(s): "${question}"`);
  }

  send({ type: 'answer-start', question });
  const priorHistory = conversationHistory.slice();
  const answer = await generateAnswer(question, (delta) => {
    send({ type: 'answer-delta', question, delta });
  }, priorHistory);
  rememberTurn(question, answer);
  if (useCache) {
    saveAnswer(question, answer).catch((err) =>
      console.warn('[kb] background save failed:', err.message),
    );
  }
  send({ type: 'answer-done', question, answer, source: 'model', followUp });
}

async function warmModel() {
  try {
    const t0 = Date.now();
    await anthropic.messages.create({
      model: ANSWER_MODEL,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'ping' }],
    });
    console.log(`[claude] warm-up ok in ${Date.now() - t0}ms (${ANSWER_MODEL})`);
  } catch (err) {
    console.warn('[claude] warm-up failed:', err.message);
  }
}

// Heuristic: does the buffered text trail off mid-clause (ends on a
// conjunction/preposition/article/auxiliary verb/filler) rather than a
// natural stop? Used to decide whether a pause is "thinking mid-sentence"
// (wait longer) vs. "done talking" (finalize soon).
const MID_CLAUSE_TRAILING_WORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'and', 'or', 'but', 'so', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'do', 'does', 'did', 'can', 'could', 'would',
  'should', 'will', 'shall', 'may', 'might', 'must', 'have', 'has', 'had',
  'that', 'which', 'who', 'whom', 'whose', 'what', 'how', 'why', 'where',
  'when', 'because', 'if', 'unless', 'while', 'although', 'though', 'whether',
  'for', 'with', 'about', 'like', 'in', 'on', 'at', 'as', 'by', 'from',
  'into', 'onto', 'over', 'under', 'between', 'through', 'during', 'before',
  'after', 'than', 'then', 'also', 'just', 'very', 'really', 'please', 'me',
  'your', 'my', 'our', 'their', 'this', 'these', 'those', 'some', 'any',
  'each', 'every', 'more', 'most', 'such', 'no', 'not', 'i', 'we', 'you',
  'it', 'um', 'uh', 'uhh', 'umm', 'ah', 'er', 'like',
]);

// Without punctuation, require a fuller phrase before treating a pause as
// "done" — short fragments like "can you explain recursion" often continue.
const MIN_COMPLETE_WORDS = 8;

function looksMidClause(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (/[?.!]$/.test(t)) return false;
  if (/[,:;-]$/.test(t)) return true;
  const words = t.split(/\s+/).filter(Boolean);
  // Unpunctuated and still short — keep waiting through the pause.
  if (words.length < MIN_COMPLETE_WORDS) return true;
  const lastWord = words[words.length - 1].toLowerCase().replace(/[^\w']/g, '');
  return MID_CLAUSE_TRAILING_WORDS.has(lastWord);
}

function looksComplete(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/[?.!]$/.test(t)) return true;
  if (looksMidClause(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  return words.length >= MIN_COMPLETE_WORDS;
}

function looksLikeAQuestion(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (t.length < MIN_UTTERANCE_CHARS) return false;
  if (/[,:;-]$/.test(t)) return false;
  if (/[?]/.test(t)) return true;

  const words = t.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const lastWord = words[words.length - 1].toLowerCase().replace(/[^\w']/g, '');
  // Still trailing mid-thought — don't answer yet.
  if (MID_CLAUSE_TRAILING_WORDS.has(lastWord)) return false;

  // Common interview-style prompts without a question mark.
  const startsLikeQuestion =
    /^(what|why|how|when|where|who|which|can you|could you|would you|tell me|explain|walk me|describe|give me|talk about)\b/i.test(
      t,
    );
  if (startsLikeQuestion && wordCount >= 3) return true;

  // Statements / prompts need enough substance to avoid answering fragments.
  if (wordCount >= MIN_COMPLETE_WORDS) return true;

  return false;
}

const SCREENSHOTS_DIR = path.join(__dirname, '../../screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// Step 1: extract the question text from the screenshot as plain text
const EXTRACT_QUESTION_PROMPT = `Look at this screenshot and extract the interview or coding question shown on screen as plain text. Return ONLY the question text itself — no preamble, no explanation. If multiple questions are visible, return the most prominent one. If no question is visible, return the single word: NONE.`;


const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.get('/health', (_req, res) => res.json({ ok: true }));

// Full-clip transcription for a saved take. More reliable than the live stream
// when a spoken turn was missed or only partly recognized.
app.post(
  '/transcribe',
  express.raw({ type: ['audio/wav', 'audio/webm', 'application/octet-stream'], limit: '12mb' }),
  async (req, res) => {
    const audio = req.body;
    if (!Buffer.isBuffer(audio) || audio.length < 44) {
      res.status(400).json({ error: 'Send a WAV audio body' });
      return;
    }
    try {
      const response = await deepgram.listen.prerecorded.transcribeFile(audio, {
        model: 'nova-2',
        smart_format: true,
        punctuate: true,
      });
      const dgError = response?.error;
      if (dgError) {
        throw new Error(dgError.message || String(dgError));
      }
      const result = response?.result || response;
      const text = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || '';
      console.log(`[transcribe] retry ${audio.length} bytes -> "${text.slice(0, 120)}"`);
      res.json({ text });
    } catch (err) {
      console.error('[transcribe] error:', err.message);
      res.status(500).json({ error: err.message || 'transcription failed' });
    }
  },
);

app.post('/clear-history', (_req, res) => {
  clearConversationHistory();
  res.json({ ok: true, turns: 0 });
});

app.get('/session', (_req, res) => {
  res.json({ profile: getSessionProfile() });
});

app.post('/session', async (req, res) => {
  const { jobDescription, resumeText, resumeFile } = req.body || {};
  try {
    const profile = await startSession({
      jobDescription,
      resumeText,
      resumeFile,
      anthropic,
      model: EXTRACT_MODEL,
    });
    clearConversationHistory();
    res.json({ profile });
  } catch (err) {
    console.error('[session] start failed:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.post('/session/clear', (_req, res) => {
  clearSession();
  clearConversationHistory();
  res.json({ ok: true, profile: null });
});

app.post('/analyze-screenshot', async (req, res) => {
  const { imageBase64 } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

  const t0 = Date.now();
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `screenshot-${timestamp}.png`;
    const filepath = path.join(SCREENSHOTS_DIR, filename);
    // Disk write off the critical path for the response.
    fs.promises
      .writeFile(filepath, Buffer.from(imageBase64, 'base64'))
      .then(() => console.log(`[screenshot] saved to ${filepath}`))
      .catch((err) => console.warn('[screenshot] save failed:', err.message));

    // Step 1: extract the question text (use a faster/cheaper model)
    const extractT0 = Date.now();
    let extractMsg;
    try {
      extractMsg = await anthropic.messages.create({
        model: EXTRACT_MODEL,
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } },
            { type: 'text', text: EXTRACT_QUESTION_PROMPT },
          ],
        }],
      });
    } catch (extractErr) {
      console.warn(`[screenshot] extract model ${EXTRACT_MODEL} failed (${extractErr.message}), falling back to ${ANSWER_MODEL}`);
      extractMsg = await anthropic.messages.create({
        model: ANSWER_MODEL,
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } },
            { type: 'text', text: EXTRACT_QUESTION_PROMPT },
          ],
        }],
      });
    }
    const extractedQuestion = extractMsg.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    console.log(`[screenshot] extract in ${Date.now() - extractT0}ms: "${extractedQuestion}"`);

    if (extractedQuestion === 'NONE') {
      return res.json({ answer: 'No interview or coding question was detected in the screenshot.', savedAs: filename, question: null, source: 'model' });
    }

    // Step 2: resolve through the same cache+KB pipeline as audio/text questions
    const result = await resolveAnswer(extractedQuestion);
    console.log(`[screenshot] total ${Date.now() - t0}ms`);
    res.json({ ...result, savedAs: filename, question: extractedQuestion });
  } catch (err) {
    console.error('[screenshot] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}

function pngSize(base64) {
  const buf = Buffer.from(String(base64 || '').slice(0, 80), 'base64');
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function normalizeHighlight(input, imageSize) {
  if (!input) return null;
  let x;
  let y;
  let w;
  let h;
  if (Array.isArray(input) && input.length >= 4) {
    [x, y, w, h] = input;
  } else if (typeof input === 'object') {
    x = input.x;
    y = input.y;
    w = input.w ?? input.width;
    h = input.h ?? input.height;
  } else {
    return null;
  }
  x = Number(x);
  y = Number(y);
  w = Number(w);
  h = Number(h);
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return null;
  // Fractions stay as-is. Anything larger is the 0–1000 grid (or pixels, scaled below).
  const max = Math.max(Math.abs(x), Math.abs(y), Math.abs(w), Math.abs(h));
  if (max > 1000 && imageSize?.width && imageSize?.height) {
    x /= imageSize.width;
    w /= imageSize.width;
    y /= imageSize.height;
    h /= imageSize.height;
  } else if (max > 1) {
    x /= 1000;
    y /= 1000;
    w /= 1000;
    h /= 1000;
  }
  x = clamp01(x);
  y = clamp01(y);
  w = clamp01(w);
  h = clamp01(h);
  if (x + w > 1) w = 1 - x;
  if (y + h > 1) h = 1 - y;
  if (w < 0.015 || h < 0.015) return null;
  if (w > 0.95 && h > 0.95) return null;
  return {
    x: Number(x.toFixed(4)),
    y: Number(y.toFixed(4)),
    w: Number(w.toFixed(4)),
    h: Number(h.toFixed(4)),
  };
}

function parseBuddyJson(raw) {
  const text = String(raw || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no json');
  return JSON.parse(candidate.slice(start, end + 1));
}

app.post('/buddy-point', async (req, res) => {
  const { question, imageBase64 } = req.body || {};
  const asked = String(question || '').trim();
  if (!asked) return res.status(400).json({ error: 'No question provided' });
  if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

  const t0 = Date.now();
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `buddy-${timestamp}.png`;
    const filepath = path.join(SCREENSHOTS_DIR, filename);
    fs.promises
      .writeFile(filepath, Buffer.from(imageBase64, 'base64'))
      .then(() => console.log(`[buddy] saved to ${filepath}`))
      .catch((err) => console.warn('[buddy] save failed:', err.message));

    const profile = getSessionProfile();
    const historyNote = conversationHistory
      .slice(-3)
      .map((turn) => `User: ${turn.question}\nBuddy: ${String(turn.answer || '').slice(0, 500)}`)
      .join('\n');

    const system = [
      'You guide someone looking at their screen. They asked a spoken question.',
      'Reply with JSON only. No markdown fences.',
      'highlight uses a 1000 by 1000 grid over the screenshot. x=0,y=0 is the top-left. x=1000,y=1000 is the bottom-right.',
      'x and y are the top-left of the box. w and h are its width and height. All four are integers from 0 to 1000.',
      'Example: the top-left quarter is {"x":0,"y":0,"w":500,"h":250}.',
      'Box only the exact control, line, code, or error the question is about. Never box the whole screen.',
      'Use null for highlight when nothing visible matches.',
      'answer is one short reply for a cursor bubble: 2–4 sentences, about 40–80 words. Markdown is fine.',
      'No preamble like "Sure".',
      profile ? formatSessionForPrompt(profile) : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const prompt = [
      historyNote ? `Recent chat:\n${historyNote}` : '',
      `Spoken question: ${asked}`,
      'Return JSON with keys "answer" (string), "label" (3-6 words, or null), and "highlight" ({"x","y","w","h"} on a 0–1000 grid, or null).',
    ]
      .filter(Boolean)
      .join('\n\n');

    const msg = await anthropic.messages.create({
      model: ANSWER_MODEL,
      max_tokens: 900,
      system,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } },
          { type: 'text', text: prompt },
        ],
      }],
    });
    const raw = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

    let answer = raw;
    let label = null;
    let highlight = null;
    try {
      const parsed = parseBuddyJson(raw);
      answer = String(parsed.answer || '').trim() || raw;
      label = parsed.label ? String(parsed.label).trim().slice(0, 80) : null;
      highlight = normalizeHighlight(parsed.highlight, pngSize(imageBase64));
    } catch (parseErr) {
      console.warn('[buddy] JSON parse failed, using raw text:', parseErr.message);
    }

    rememberTurn(asked, answer);
    console.log(`[buddy] point in ${Date.now() - t0}ms highlight=${highlight ? 'yes' : 'no'}`);
    res.json({ answer, label, highlight, question: asked, source: 'guide', savedAs: filename });
  } catch (err) {
    console.error('[buddy] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (clientSocket) => {
  console.log('[ws] client connected');
  let chunkCount = 0;
  let dgIsOpen = false;
  let dgConnection = null;
  let reconnectTimer = null;
  let reconnecting = false;
  let clientGone = false;
  const pendingChunks = [];
  let pendingBytes = 0;
  const MAX_PENDING_BYTES = 16000 * 2 * 8;

  const bufferChunk = (chunk) => {
    pendingChunks.push(chunk);
    pendingBytes += chunk.length;
    while (pendingBytes > MAX_PENDING_BYTES && pendingChunks.length > 1) {
      pendingBytes -= pendingChunks.shift().length;
    }
  };
  let finalBuffer = '';
  let finalizeTimer = null;
  let answerInFlight = false;
  let lastAnsweredText = '';
  let lastAnswerAt = 0;
  let buddyMode = false;

  const send = (payload) => {
    if (clientSocket.readyState === clientSocket.OPEN) {
      clientSocket.send(JSON.stringify(payload));
    }
  };

  const clearFinalizeTimer = () => {
    if (finalizeTimer) clearTimeout(finalizeTimer);
    finalizeTimer = null;
  };

  const enqueueFinalize = ({ fromSpeechFinal = false } = {}) => {
    clearFinalizeTimer();
    // Prefer waiting through mid-question pauses. Only use the shorter
    // delay when the buffer already looks like a finished turn.
    const delay = looksComplete(finalBuffer) && fromSpeechFinal
      ? UTTERANCE_SILENCE_MS
      : UTTERANCE_MAX_PAUSE_MS;
    console.log(
      `[utterance] arm finalize in ${delay}ms (speech_final=${fromSpeechFinal}, complete=${looksComplete(finalBuffer)}): "${finalBuffer}"`,
    );
    finalizeTimer = setTimeout(async () => {
      finalizeTimer = null;
      const question = finalBuffer.trim();

      if (!looksLikeAQuestion(question)) {
        // Incomplete fragment after a long pause — keep buffering so the
        // rest of the question can append instead of answering a stump.
        console.log(`[utterance] holding incomplete buffer: "${question}"`);
        finalizeTimer = setTimeout(() => {
          finalizeTimer = null;
          if (finalBuffer.trim() === question) {
            console.log(`[utterance] dropping stale incomplete buffer: "${question}"`);
            finalBuffer = '';
          }
        }, UTTERANCE_MAX_PAUSE_MS);
        return;
      }

      // Commit only once we are ready to answer.
      finalBuffer = '';

      // Prevent back-to-back duplicates from endpoint jitter.
      const now = Date.now();
      if (question === lastAnsweredText && now - lastAnswerAt < 3000) return;
      if (answerInFlight) return;

      answerInFlight = true;
      lastAnsweredText = question;
      lastAnswerAt = now;
      console.log(`[utterance] answering: "${question}"`);

      try {
        if (buddyMode) {
          console.log(`[buddy] voice question, waiting for screen point: "${question}"`);
          send({ type: 'buddy-question', question });
        } else {
          await streamAnswerToClient(send, question);
        }
      } catch (err) {
        send({ type: 'error', message: `Answer error: ${err.message}` });
      } finally {
        answerInFlight = false;
      }
    }, delay);
  };

  // Raw linear16 has no container header, so a dropped socket can reconnect
  // and keep transcribing. Compressed webm slices could not.
  const startDeepgram = () => {
    if (clientGone) return;
    const dg = deepgram.listen.live({
      model: 'nova-2',
      smart_format: true,
      interim_results: true,
      encoding: 'linear16',
      sample_rate: 16000,
      channels: 1,
      endpointing: DG_ENDPOINTING_MS,
      // Silence gap Deepgram needs before UtteranceEnd. Keep above endpointing
      // so brief thinking pauses don't close the turn.
      utterance_end_ms: Math.min(5000, Math.max(DG_ENDPOINTING_MS + 400, 1600)),
      vad_events: true,
    });
    dgConnection = dg;

    dg.on(LiveTranscriptionEvents.Open, () => {
      if (dg !== dgConnection) return;
      dgIsOpen = true;
      console.log(`[ws] deepgram open, flushing ${pendingChunks.length} buffered chunks`);
      for (const buffered of pendingChunks) dg.send(buffered);
      pendingChunks.length = 0;
      pendingBytes = 0;
      send({ type: 'status', message: 'transcription-ready' });
    });

    dg.on(LiveTranscriptionEvents.Transcript, async (data) => {
      if (dg !== dgConnection) return;
      const alt = data.channel?.alternatives?.[0];
      const text = alt?.transcript?.trim();
      if (!text) return;

      const isFinal = Boolean(data.is_final);
      send({ type: 'transcript', text, isFinal });

      // Interim audio means the speaker resumed — cancel any pending answer
      // so a thinking pause doesn't split one question into multiple.
      if (!isFinal) {
        clearFinalizeTimer();
        return;
      }

      // Build a single utterance across short pauses.
      finalBuffer = `${finalBuffer} ${text}`.trim();

      // Prefer Deepgram's end-of-speech signal. Still arm a long fallback on
      // plain `is_final` so we don't hang if `speech_final` is missing — but
      // never use the short delay for those mid-pause segment finals.
      const speechFinal = Boolean(data.speech_final);
      enqueueFinalize({ fromSpeechFinal: speechFinal });
    });

    // Fallback end-of-turn when Deepgram's utterance detector fires.
    if (LiveTranscriptionEvents.UtteranceEnd) {
      dg.on(LiveTranscriptionEvents.UtteranceEnd, () => {
        if (dg !== dgConnection) return;
        if (!finalBuffer.trim()) return;
        console.log(`[utterance] deepgram UtteranceEnd: "${finalBuffer}"`);
        enqueueFinalize({ fromSpeechFinal: true });
      });
    }

    dg.on(LiveTranscriptionEvents.Error, (err) => {
      console.error('[deepgram] error', err);
      send({ type: 'error', message: `Deepgram error: ${err.message || err}` });
    });

    dg.on(LiveTranscriptionEvents.Close, (closeEvent) => {
      console.log('[deepgram] closed', closeEvent?.code, closeEvent?.reason);
      if (dg !== dgConnection) return;
      dgIsOpen = false;
      if (clientGone || reconnecting) return;
      reconnecting = true;
      send({ type: 'status', message: 'transcription-reconnecting' });
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnecting = false;
        console.log('[deepgram] reconnecting');
        startDeepgram();
      }, 400);
    });
  };

  startDeepgram();

  clientSocket.on('message', async (chunk, isBinary) => {
    if (!isBinary) {
      try {
        const message = JSON.parse(chunk.toString());
        if (message.type === 'clear-history') {
          clearConversationHistory();
          send({ type: 'status', message: 'history-cleared' });
          return;
        }
        if (message.type === 'buddy-mode') {
          buddyMode = Boolean(message.enabled);
          console.log(`[buddy] mode ${buddyMode ? 'on' : 'off'}`);
          return;
        }
        if (message.type === 'text-question') {
          console.log('[ws] received text question:', message.text);
          try {
            await streamAnswerToClient(send, message.text);
          } catch (err) {
            send({ type: 'error', message: `Answer error: ${err.message}` });
          }
        }
      } catch (err) {
        console.log('[ws] received non-binary message, ignoring:', chunk.toString());
      }
      return;
    }
    chunkCount += 1;
    if (chunkCount === 1 || chunkCount % 20 === 0) {
      console.log(`[ws] audio chunk #${chunkCount}, size=${chunk.length}, dgReadyState=${dgConnection?.getReadyState?.()}`);
    }
    if (dgIsOpen && dgConnection) {
      dgConnection.send(chunk);
    } else {
      bufferChunk(chunk);
    }
  });

  clientSocket.on('close', () => {
    console.log(`[ws] client disconnected after ${chunkCount} chunks`);
    clientGone = true;
    clearTimeout(reconnectTimer);
    clearFinalizeTimer();
    try {
      dgConnection?.finish();
    } catch (err) {
      console.warn('[deepgram] finish failed', err.message);
    }
  });
});

connectDb()
  .then(() => initEmbeddings())
  .then(() => backfillEmbeddings())
  .then(() => warmModel())
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Backend listening on http://localhost:${PORT} (ws path: /ws)`);
    });
  })
  .catch((err) => {
    console.error('[startup] failed:', err.message);
    process.exit(1);
  });

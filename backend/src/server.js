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
const SYSTEM_PROMPT = `You are a sharp interview co-pilot. Give a clear spoken answer the candidate can use.
No preamble ("Sure", "Here's an answer") — answer content only.

Target ~200–350 words. Be useful, not an essay.

IMPORTANT: For every coding / technical question, write all code examples in JavaScript only
(Node.js-style when backend context fits). Do not use Python, Java, C++, TypeScript-only syntax,
or other languages unless the question explicitly asks for that language.

If earlier turns are in the conversation, treat short or referential questions
("give an example", "why?", "what about that", "can you elaborate") as follow-ups
to that context. Do not ask the candidate to restate the prior question.

Structure:
1. Direct answer (1–2 sentences)
2. Key points as bullets (4–6 bullets)
3. One short real-world / spoken example
4. If technical: a small JavaScript code snippet (≤15 lines) + 1–2 trade-offs
5. 2 likely follow-up questions with one-line replies

Prefer bullets. Skip fluff.`;

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
    system: SYSTEM_PROMPT,
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

  // Follow-ups must not hit the standalone KB cache ("give an example" ≠ closures).
  if (!followUp) {
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
  } else {
    console.log(`[history] follow-up with ${conversationHistory.length} prior turn(s): "${question}"`);
  }

  console.log(`[kb] cache miss, calling model: "${question}"`);
  // Snapshot history before this turn so we don't include the current Q yet.
  const priorHistory = conversationHistory.slice();
  const answer = await generateAnswer(question, onDelta, priorHistory);
  rememberTurn(question, answer);
  if (!followUp) {
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

  if (!followUp) {
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
  } else {
    console.log(`[history] follow-up with ${conversationHistory.length} prior turn(s): "${question}"`);
  }

  send({ type: 'answer-start', question });
  const priorHistory = conversationHistory.slice();
  const answer = await generateAnswer(question, (delta) => {
    send({ type: 'answer-delta', question, delta });
  }, priorHistory);
  rememberTurn(question, answer);
  if (!followUp) {
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

app.post('/clear-history', (_req, res) => {
  clearConversationHistory();
  res.json({ ok: true, turns: 0 });
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

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (clientSocket) => {
  console.log('[ws] client connected');
  let chunkCount = 0;
  let dgIsOpen = false;
  const pendingChunks = [];
  let finalBuffer = '';
  let finalizeTimer = null;
  let answerInFlight = false;
  let lastAnsweredText = '';
  let lastAnswerAt = 0;

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
        await streamAnswerToClient(send, question);
      } catch (err) {
        send({ type: 'error', message: `Answer error: ${err.message}` });
      } finally {
        answerInFlight = false;
      }
    }, delay);
  };

  const dgConnection = deepgram.listen.live({
    model: 'nova-2',
    smart_format: true,
    interim_results: true,
    endpointing: DG_ENDPOINTING_MS,
    // Silence gap Deepgram needs before UtteranceEnd. Keep above endpointing
    // so brief thinking pauses don't close the turn.
    utterance_end_ms: Math.min(5000, Math.max(DG_ENDPOINTING_MS + 400, 1600)),
    vad_events: true,
  });

  dgConnection.on(LiveTranscriptionEvents.Open, () => {
    dgIsOpen = true;
    console.log(`[ws] deepgram open, flushing ${pendingChunks.length} buffered chunks`);
    for (const buffered of pendingChunks) {
      dgConnection.send(buffered);
    }
    pendingChunks.length = 0;
    send({ type: 'status', message: 'transcription-ready' });
  });

  dgConnection.on(LiveTranscriptionEvents.Transcript, async (data) => {
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
    dgConnection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
      if (!finalBuffer.trim()) return;
      console.log(`[utterance] deepgram UtteranceEnd: "${finalBuffer}"`);
      enqueueFinalize({ fromSpeechFinal: true });
    });
  }

  dgConnection.on(LiveTranscriptionEvents.Error, (err) => {
    console.error('[deepgram] error', err);
    send({ type: 'error', message: `Deepgram error: ${err.message || err}` });
  });

  dgConnection.on(LiveTranscriptionEvents.Close, (closeEvent) => {
    console.log('[deepgram] closed', closeEvent?.code, closeEvent?.reason);
    send({ type: 'status', message: 'transcription-closed' });
  });

  clientSocket.on('message', async (chunk, isBinary) => {
    if (!isBinary) {
      try {
        const message = JSON.parse(chunk.toString());
        if (message.type === 'clear-history') {
          clearConversationHistory();
          send({ type: 'status', message: 'history-cleared' });
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
      console.log(`[ws] audio chunk #${chunkCount}, size=${chunk.length}, dgReadyState=${dgConnection.getReadyState()}`);
    }
    if (dgIsOpen) {
      dgConnection.send(chunk);
    } else {
      pendingChunks.push(chunk);
    }
  });

  clientSocket.on('close', () => {
    console.log(`[ws] client disconnected after ${chunkCount} chunks`);
    clearFinalizeTimer();
    dgConnection.finish();
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

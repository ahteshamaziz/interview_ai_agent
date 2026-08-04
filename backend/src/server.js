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
const DG_ENDPOINTING_MS = Number(process.env.DG_ENDPOINTING_MS || 900);
// Two-tier silence debounce: finalize quickly once the utterance sounds
// complete, but keep waiting through longer pauses when it trails off
// mid-clause — slow speakers / frequent pauses shouldn't get cut into
// fragments and answered piecemeal.
const UTTERANCE_SILENCE_MS = Number(process.env.UTTERANCE_SILENCE_MS || 1100);
const UTTERANCE_MAX_PAUSE_MS = Number(process.env.UTTERANCE_MAX_PAUSE_MS || 3000);
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

async function generateAnswer(transcriptText, onDelta) {
  const t0 = Date.now();
  const stream = anthropic.messages.stream({
    model: ANSWER_MODEL,
    max_tokens: ANSWER_MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: transcriptText }],
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
  console.log(`[claude] complete in ${Date.now() - t0}ms (${full.length} chars)`);
  return full;
}

async function resolveAnswer(question, onDelta) {
  const t0 = Date.now();
  // Exact-only on the hot path — embedding semantic search is too slow for 1–2s.
  const cached = await lookupExactAnswer(question);
  if (cached) {
    console.log(`[kb] cache hit (${cached.matchType}) in ${Date.now() - t0}ms: "${question}"`);
    return {
      answer: cached.answer,
      source: 'cache',
      matchType: cached.matchType,
      matchedQuestion: cached.matchedQuestion,
    };
  }

  console.log(`[kb] cache miss, calling model: "${question}"`);
  const answer = await generateAnswer(question, onDelta);
  saveAnswer(question, answer).catch((err) =>
    console.warn('[kb] background save failed:', err.message),
  );
  console.log(`[resolve] model answer ready in ${Date.now() - t0}ms`);
  return { answer, source: 'model' };
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
  'were', 'do', 'does', 'did', 'can', 'could', 'would', 'should', 'will',
  'that', 'which', 'who', 'what', 'how', 'why', 'because', 'if', 'when',
  'for', 'with', 'about', 'like', 'in', 'on', 'at', 'as', 'by', 'from', 'i',
  'we', 'you', 'it', 'my', 'your', 'um', 'uh', 'uhh', 'umm',
]);

const MIN_COMPLETE_WORDS = 4;

function looksMidClause(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (/[?.!]$/.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  // Unpunctuated and still short (e.g. "can you explain") — too early to
  // tell if it's a real complete question, so keep waiting.
  if (words.length < MIN_COMPLETE_WORDS) return true;
  const lastWord = words[words.length - 1].toLowerCase().replace(/[^\w']/g, '');
  return MID_CLAUSE_TRAILING_WORDS.has(lastWord);
}

function looksLikeAQuestion(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (t.length < MIN_UTTERANCE_CHARS) return false;
  // If we have a reasonable amount of text, treat it as answer-worthy even
  // if it doesn't look like a question (many interview prompts are statements).
  const wordCount = t.split(/\s+/).filter(Boolean).length;
  if (wordCount >= 3) return true;
  if (/[?]/.test(t)) return true;

  // Common interview-style prompts without a question mark.
  const startsLikeQuestion =
    /^(what|why|how|when|where|who|which|can you|could you|would you|tell me|explain|walk me|describe)\b/i.test(t);
  if (startsLikeQuestion) return true;

  // If it ends like a clause, it's probably incomplete.
  if (/[,:-]$/.test(t)) return false;

  return true;
}

const SCREENSHOTS_DIR = path.join(__dirname, '../../screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// Step 1: extract the question text from the screenshot as plain text
const EXTRACT_QUESTION_PROMPT = `Look at this screenshot and extract the interview or coding question shown on screen as plain text. Return ONLY the question text itself — no preamble, no explanation. If multiple questions are visible, return the most prominent one. If no question is visible, return the single word: NONE.`;


const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.get('/health', (_req, res) => res.json({ ok: true }));

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

  const enqueueFinalize = () => {
    clearFinalizeTimer();
    const delay = looksMidClause(finalBuffer) ? UTTERANCE_MAX_PAUSE_MS : UTTERANCE_SILENCE_MS;
    finalizeTimer = setTimeout(async () => {
      finalizeTimer = null;
      const question = finalBuffer.trim();
      finalBuffer = '';

      if (!looksLikeAQuestion(question)) return;

      // Prevent back-to-back duplicates from endpoint jitter.
      const now = Date.now();
      if (question === lastAnsweredText && now - lastAnswerAt < 3000) return;
      if (answerInFlight) return;

      answerInFlight = true;
      lastAnsweredText = question;
      lastAnswerAt = now;

      try {
        const cached = await lookupExactAnswer(question);
        if (cached) {
          console.log(`[kb] cache hit (${cached.matchType}): "${question}"`);
          send({
            type: 'answer',
            question,
            answer: cached.answer,
            source: 'cache',
            matchType: cached.matchType,
            matchedQuestion: cached.matchedQuestion,
          });
        } else {
          send({ type: 'answer-start', question });
          const answer = await generateAnswer(question, (delta) => {
            send({ type: 'answer-delta', question, delta });
          });
          saveAnswer(question, answer).catch((err) =>
            console.warn('[kb] background save failed:', err.message),
          );
          send({ type: 'answer-done', question, answer, source: 'model' });
        }
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

    if (isFinal) {
      // Build a single utterance across short pauses.
      finalBuffer = `${finalBuffer} ${text}`.trim();
      // Keep "end of turn" debounce progressing even when `speech_final` is not emitted.
      enqueueFinalize();
    }

    // Deepgram can mark `speech_final` on short pauses; debounce before answering.
    const speechFinal = Boolean(data.speech_final);
    if (speechFinal) enqueueFinalize();
  });

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
        if (message.type === 'text-question') {
          console.log('[ws] received text question:', message.text);
          try {
            const cached = await lookupExactAnswer(message.text);
            if (cached) {
              console.log(`[kb] cache hit (${cached.matchType}): "${message.text}"`);
              send({
                type: 'answer',
                question: message.text,
                answer: cached.answer,
                source: 'cache',
                matchType: cached.matchType,
                matchedQuestion: cached.matchedQuestion,
              });
            } else {
              send({ type: 'answer-start', question: message.text });
              const answer = await generateAnswer(message.text, (delta) => {
                send({ type: 'answer-delta', question: message.text, delta });
              });
              saveAnswer(message.text, answer).catch((err) =>
                console.warn('[kb] background save failed:', err.message),
              );
              send({ type: 'answer-done', question: message.text, answer, source: 'model' });
            }
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

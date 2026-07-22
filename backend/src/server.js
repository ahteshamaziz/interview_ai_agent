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
const { lookupAnswer, saveAnswer, backfillEmbeddings } = require('./knowledgeBase');

const PORT = process.env.PORT || 8787;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DG_ENDPOINTING_MS = Number(process.env.DG_ENDPOINTING_MS || 900);
const UTTERANCE_SILENCE_MS = Number(process.env.UTTERANCE_SILENCE_MS || 900);
const MIN_UTTERANCE_CHARS = Number(process.env.MIN_UTTERANCE_CHARS || 12);

if (!DEEPGRAM_API_KEY) throw new Error('Missing DEEPGRAM_API_KEY in backend/.env');
if (!ANTHROPIC_API_KEY) throw new Error('Missing ANTHROPIC_API_KEY in backend/.env');

const deepgram = createClient(DEEPGRAM_API_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a calm, sharp interview co-pilot. You receive a live transcript fragment of
a question being asked in a job interview. Reply with a concise, well-structured suggested answer
the candidate could say out loud. Keep it under 500 words, use plain spoken language, and skip any
preamble like "Sure" or "Here's an answer" — just give the answer content itself. Give answer in bullet and examples If It is technical give some code examples.`;

async function generateAnswer(transcriptText) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: transcriptText }],
  });
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

async function resolveAnswer(question) {
  const cached = await lookupAnswer(question);
  if (cached) {
    console.log(`[kb] cache hit (${cached.matchType}): "${question}"`);
    return {
      answer: cached.answer,
      source: 'cache',
      matchType: cached.matchType,
      matchedQuestion: cached.matchedQuestion,
    };
  }

  console.log(`[kb] cache miss, calling model: "${question}"`);
  const answer = await generateAnswer(question);
  await saveAnswer(question, answer);
  return { answer, source: 'model' };
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

  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `screenshot-${timestamp}.png`;
    const filepath = path.join(SCREENSHOTS_DIR, filename);
    fs.writeFileSync(filepath, Buffer.from(imageBase64, 'base64'));
    console.log(`[screenshot] saved to ${filepath}`);

    // Step 1: extract the question text from the image
    const extractMsg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } },
          { type: 'text', text: EXTRACT_QUESTION_PROMPT },
        ],
      }],
    });
    const extractedQuestion = extractMsg.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    console.log(`[screenshot] extracted question: "${extractedQuestion}"`);

    if (extractedQuestion === 'NONE') {
      return res.json({ answer: 'No interview or coding question was detected in the screenshot.', savedAs: filename, question: null, source: 'model' });
    }

    // Step 2: resolve through the same cache+KB pipeline as audio/text questions
    const result = await resolveAnswer(extractedQuestion);
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
        const result = await resolveAnswer(question);
        send({ type: 'answer', question, ...result });
      } catch (err) {
        send({ type: 'error', message: `Answer error: ${err.message}` });
      } finally {
        answerInFlight = false;
      }
    }, UTTERANCE_SILENCE_MS);
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
            const result = await resolveAnswer(message.text);
            send({ type: 'answer', question: message.text, ...result });
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
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Backend listening on http://localhost:${PORT} (ws path: /ws)`);
    });
  })
  .catch((err) => {
    console.error('[startup] failed:', err.message);
    process.exit(1);
  });

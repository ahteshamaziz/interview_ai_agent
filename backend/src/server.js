require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const Anthropic = require('@anthropic-ai/sdk');

const PORT = process.env.PORT || 8787;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!DEEPGRAM_API_KEY) throw new Error('Missing DEEPGRAM_API_KEY in backend/.env');
if (!ANTHROPIC_API_KEY) throw new Error('Missing ANTHROPIC_API_KEY in backend/.env');

const deepgram = createClient(DEEPGRAM_API_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a calm, sharp interview co-pilot. You receive a live transcript fragment of
a question being asked in a job interview. Reply with a concise, well-structured suggested answer
the candidate could say out loud. Keep it under 120 words, use plain spoken language, and skip any
preamble like "Sure" or "Here's an answer" — just give the answer content itself.`;

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

const app = express();
app.use(cors());
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (clientSocket) => {
  console.log('[ws] client connected');
  let chunkCount = 0;
  let dgIsOpen = false;
  const pendingChunks = [];

  const send = (payload) => {
    if (clientSocket.readyState === clientSocket.OPEN) {
      clientSocket.send(JSON.stringify(payload));
    }
  };

  const dgConnection = deepgram.listen.live({
    model: 'nova-2',
    smart_format: true,
    interim_results: true,
    endpointing: 300,
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

    const speechFinal = Boolean(data.speech_final);
    if (speechFinal) {
      try {
        const answer = await generateAnswer(text);
        send({ type: 'answer', question: text, answer });
      } catch (err) {
        send({ type: 'error', message: `LLM error: ${err.message}` });
      }
    }
  });

  dgConnection.on(LiveTranscriptionEvents.Error, (err) => {
    console.error('[deepgram] error', err);
    send({ type: 'error', message: `Deepgram error: ${err.message || err}` });
  });

  dgConnection.on(LiveTranscriptionEvents.Close, (closeEvent) => {
    console.log('[deepgram] closed', closeEvent?.code, closeEvent?.reason);
    send({ type: 'status', message: 'transcription-closed' });
  });

  clientSocket.on('message', (chunk, isBinary) => {
    if (!isBinary) {
      console.log('[ws] received non-binary message, ignoring:', chunk.toString());
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
    dgConnection.finish();
  });
});

server.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT} (ws path: /ws)`);
});

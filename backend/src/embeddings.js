const { pipeline } = require('@xenova/transformers');

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

let embedder;

async function initEmbeddings() {
  if (embedder) return;
  console.log(`[embeddings] loading local model ${MODEL_ID}...`);
  embedder = await pipeline('feature-extraction', MODEL_ID);
  console.log('[embeddings] model ready');
}

async function embedText(text) {
  if (!embedder) throw new Error('Embeddings not initialized. Call initEmbeddings() first.');
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

module.exports = { initEmbeddings, embedText, cosineSimilarity };

const { getDb } = require('./db');
const { embedText, cosineSimilarity } = require('./embeddings');

const COLLECTION = 'knowledge_entries';
const SEMANTIC_THRESHOLD = 0.85;

function normalizeQuestion(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function findSimilarEntry(question) {
  const db = getDb();
  const normalized = normalizeQuestion(question);

  const exact = await db.collection(COLLECTION).findOne({ normalizedQuestion: normalized });
  if (exact) return { entry: exact, matchType: 'exact' };

  const queryEmbedding = await embedText(question);
  const candidates = await db.collection(COLLECTION)
    .find({ embedding: { $exists: true } })
    .toArray();

  let best = null;
  let bestScore = 0;

  for (const entry of candidates) {
    const score = cosineSimilarity(queryEmbedding, entry.embedding);
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }

  if (best && bestScore >= SEMANTIC_THRESHOLD) {
    return { entry: best, matchType: 'semantic', score: bestScore };
  }

  return null;
}

async function lookupAnswer(question) {
  const match = await findSimilarEntry(question);
  if (!match) return null;

  const db = getDb();
  await db.collection(COLLECTION).updateOne(
    { _id: match.entry._id },
    { $inc: { hitCount: 1 }, $set: { lastUsedAt: new Date() } },
  );

  return {
    answer: match.entry.answer,
    matchedQuestion: match.entry.question,
    matchType: match.matchType,
    score: match.score,
  };
}

async function saveAnswer(question, answer) {
  const db = getDb();
  const normalized = normalizeQuestion(question);
  const embedding = await embedText(question);
  const now = new Date();

  await db.collection(COLLECTION).updateOne(
    { normalizedQuestion: normalized },
    {
      $set: { question, answer, embedding, updatedAt: now },
      $setOnInsert: { normalizedQuestion: normalized, createdAt: now, hitCount: 0 },
    },
    { upsert: true },
  );
}

async function backfillEmbeddings() {
  const db = getDb();
  const missing = await db.collection(COLLECTION)
    .find({ embedding: { $exists: false } })
    .toArray();

  for (const entry of missing) {
    const embedding = await embedText(entry.question);
    await db.collection(COLLECTION).updateOne(
      { _id: entry._id },
      { $set: { embedding } },
    );
  }

  if (missing.length > 0) {
    console.log(`[kb] backfilled embeddings for ${missing.length} entries`);
  }
}

module.exports = { lookupAnswer, saveAnswer, backfillEmbeddings, normalizeQuestion };

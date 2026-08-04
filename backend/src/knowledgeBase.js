const { getDb } = require('./db');
const { embedText, cosineSimilarity } = require('./embeddings');

const COLLECTION = 'knowledge_entries';
// all-MiniLM-L6-v2 cosine scores for true paraphrases (esp. noisy live-transcript
// phrasing like "so um can you tell me what you understand by the event loop")
// land around 0.67-0.86, while genuinely different questions top out ~0.59.
// 0.85 was rejecting most real paraphrases; 0.72 keeps a solid margin above the
// closest confusable pair we measured (~0.59) while catching real paraphrases.
const SEMANTIC_THRESHOLD = Number(process.env.SEMANTIC_THRESHOLD || 0.72);

// In-memory index so semantic lookup doesn't re-fetch every embedding from Mongo
// on every question (that was a major latency source once the KB grew).
let memoryIndex = null;

function normalizeQuestion(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function ensureMemoryIndex() {
  if (memoryIndex) return memoryIndex;
  const db = getDb();
  const candidates = await db
    .collection(COLLECTION)
    .find({ embedding: { $exists: true } })
    .project({ question: 1, answer: 1, embedding: 1, normalizedQuestion: 1 })
    .toArray();
  memoryIndex = candidates;
  console.log(`[kb] loaded ${memoryIndex.length} embeddings into memory`);
  return memoryIndex;
}

function upsertMemoryEntry(entry) {
  if (!memoryIndex) return;
  const idx = memoryIndex.findIndex(
    (e) => e.normalizedQuestion === entry.normalizedQuestion || String(e._id) === String(entry._id),
  );
  if (idx >= 0) memoryIndex[idx] = { ...memoryIndex[idx], ...entry };
  else memoryIndex.push(entry);
}

async function findExactEntry(question) {
  const db = getDb();
  const normalized = normalizeQuestion(question);
  return db.collection(COLLECTION).findOne({ normalizedQuestion: normalized });
}

async function findSemanticEntry(question) {
  const index = await ensureMemoryIndex();
  if (index.length === 0) return null;

  const queryEmbedding = await embedText(question);
  let best = null;
  let bestScore = 0;

  for (const entry of index) {
    if (!entry.embedding) continue;
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

async function findSimilarEntry(question) {
  const exact = await findExactEntry(question);
  if (exact) return { entry: exact, matchType: 'exact' };

  // Semantic embed is slow (~200-800ms). Skip it on the hot path so model
  // calls can start immediately (needed for 1–2s answers).
  if (process.env.SKIP_SEMANTIC_LOOKUP !== 'false') return null;

  return findSemanticEntry(question);
}

function toLookupResult(match) {
  if (!match) return null;
  getDb()
    .collection(COLLECTION)
    .updateOne(
      { _id: match.entry._id },
      { $inc: { hitCount: 1 }, $set: { lastUsedAt: new Date() } },
    )
    .catch((err) => console.warn('[kb] hitCount update failed:', err.message));

  return {
    answer: match.entry.answer,
    matchedQuestion: match.entry.question,
    matchType: match.matchType,
    score: match.score,
  };
}

async function lookupExactAnswer(question) {
  const t0 = Date.now();
  const exact = await findExactEntry(question);
  if (!exact) {
    console.log(`[kb] exact miss in ${Date.now() - t0}ms`);
    return null;
  }
  console.log(`[kb] exact hit in ${Date.now() - t0}ms`);
  return toLookupResult({ entry: exact, matchType: 'exact' });
}

async function lookupAnswer(question) {
  const t0 = Date.now();
  const match = await findSimilarEntry(question);
  if (!match) {
    console.log(`[kb] lookup miss in ${Date.now() - t0}ms`);
    return null;
  }
  console.log(`[kb] lookup hit (${match.matchType}) in ${Date.now() - t0}ms`);
  return toLookupResult(match);
}

async function saveAnswer(question, answer) {
  const db = getDb();
  const normalized = normalizeQuestion(question);
  const embedding = await embedText(question);
  const now = new Date();

  const saved = await db.collection(COLLECTION).findOneAndUpdate(
    { normalizedQuestion: normalized },
    {
      $set: { question, answer, embedding, updatedAt: now },
      $setOnInsert: { normalizedQuestion: normalized, createdAt: now, hitCount: 0 },
    },
    { upsert: true, returnDocument: 'after' },
  );

  // Driver 6+ returns the document directly; older shapes used { value }.
  const entry = saved?.value ?? saved ?? {
    question,
    answer,
    embedding,
    normalizedQuestion: normalized,
  };
  upsertMemoryEntry(entry);
  return entry;
}

async function backfillEmbeddings() {
  const db = getDb();
  const missing = await db
    .collection(COLLECTION)
    .find({ embedding: { $exists: false } })
    .toArray();

  for (const entry of missing) {
    const embedding = await embedText(entry.question);
    await db.collection(COLLECTION).updateOne({ _id: entry._id }, { $set: { embedding } });
  }

  if (missing.length > 0) {
    console.log(`[kb] backfilled embeddings for ${missing.length} entries`);
  }

  // Warm the in-memory index after backfill so the first real query is fast.
  memoryIndex = null;
  await ensureMemoryIndex();
}

module.exports = {
  lookupAnswer,
  lookupExactAnswer,
  saveAnswer,
  backfillEmbeddings,
  normalizeQuestion,
};

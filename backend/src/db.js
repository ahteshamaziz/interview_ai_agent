const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/interview_ai';

let client;
let db;

async function connectDb() {
  if (db) return db;
  client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db();
  await db.collection('knowledge_entries').createIndex({ normalizedQuestion: 1 }, { unique: true });
  console.log('[db] connected to MongoDB');
  return db;
}

function getDb() {
  if (!db) throw new Error('Database not connected. Call connectDb() first.');
  return db;
}

async function closeDb() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

module.exports = { connectDb, getDb, closeDb };

import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Document } from "@langchain/core/documents";
import { COLLECTIONS, parseKbFile } from "./frontmatter";
import {
  DB_NAME,
  KB_COLLECTION,
  VECTOR_INDEX_NAME,
  getVectorStore,
  mongoClient,
  toDocument,
} from "./store";

const KNOWLEDGE_ROOT = path.resolve(process.cwd(), "knowledge");

// Voyage's free tier (no payment method on file) caps requests at 3/minute.
// MongoDBAtlasVectorSearch.addDocuments() hands its whole input array to
// VoyageEmbeddings.embedDocuments() in one call, which internally chunks by
// its own batchSize (8, Voyage's per-request max) but fires ALL of those
// chunk requests concurrently via Promise.all — there's no built-in delay.
// So we throttle from the outside: feed addDocuments() one Voyage-sized
// chunk at a time (one chunk == exactly one API request) and wait between
// calls, keeping well under 3 requests/minute.
const EMBED_BATCH_SIZE = 8;
const BATCH_DELAY_MS = 22_000;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadDocuments(): Promise<Document[]> {
  const docs: Document[] = [];

  for (const collection of COLLECTIONS) {
    const dir = path.join(KNOWLEDGE_ROOT, collection);
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
    } catch {
      process.stdout.write(`  (no ${collection}/ directory, skipping)\n`);
      continue;
    }

    for (const file of files) {
      const rel = `${collection}/${file}`;
      const raw = await readFile(path.join(dir, file), "utf8");
      const { frontmatter, body } = parseKbFile(raw, rel);
      docs.push(toDocument(frontmatter, body, rel));
    }
    process.stdout.write(`  ${collection}: ${files.length} documents\n`);
  }

  return docs;
}

/**
 * Atlas Local supports vector search, but the index has to exist before any
 * query runs. Creating it is idempotent — a duplicate name is not an error
 * worth failing the seed over.
 */
async function ensureVectorIndex(numDimensions: number): Promise<void> {
  const client = await mongoClient();
  const collection = client.db(DB_NAME).collection(KB_COLLECTION);

  try {
    await collection.createSearchIndex({
      name: VECTOR_INDEX_NAME,
      type: "vectorSearch",
      definition: {
        fields: [
          { type: "vector", path: "embedding", numDimensions, similarity: "cosine" },
          // Filterable metadata — these are what make pre-filtered retrieval work.
          { type: "filter", path: "collection" },
          { type: "filter", path: "airlines" },
          { type: "filter", path: "programs" },
          { type: "filter", path: "cabin" },
        ],
      },
    });
    process.stdout.write(`Created vector index "${VECTOR_INDEX_NAME}".\n`);
  } catch (err) {
    const message = (err as Error).message ?? "";
    if (/already exists|Duplicate/i.test(message)) {
      process.stdout.write(`Vector index "${VECTOR_INDEX_NAME}" already exists.\n`);
    } else {
      throw err;
    }
  }
}

async function main(): Promise<void> {
  process.stdout.write("Loading knowledge base...\n");
  const docs = await loadDocuments();
  if (docs.length === 0) {
    throw new Error("No knowledge documents found — nothing to ingest.");
  }

  const client = await mongoClient();
  const db = client.db(DB_NAME);

  // createSearchIndex requires the collection to already exist. On a first
  // run there's nothing to delete and deleteMany() is a no-op that never
  // creates it, so create it explicitly rather than relying on that as a
  // side effect.
  const existing = await db.listCollections({ name: KB_COLLECTION }).toArray();
  if (existing.length === 0) {
    await db.createCollection(KB_COLLECTION);
  }
  const collection = db.collection(KB_COLLECTION);

  // Full replace. The KB is small and hand-authored; incremental sync would be
  // more machinery than the problem deserves.
  await collection.deleteMany({});
  process.stdout.write(`Cleared ${KB_COLLECTION}.\n`);

  // voyage-3 emits 1024-dimension vectors. Probe rather than hardcode so a
  // model change does not silently produce an unusable index.
  const store = await getVectorStore();
  const probe = await store.embeddings.embedQuery("dimension probe");
  await ensureVectorIndex(probe.length);

  // The dimension probe above is itself a Voyage request, so it occupies one
  // of the 3-requests-per-minute slots. Wait it out before the first batch —
  // otherwise probe + batch 1 land back-to-back and only leave room for one
  // more batch inside the rolling 60s window before the API 429s.
  process.stdout.write(
    `  Waiting ${BATCH_DELAY_MS / 1000}s after the dimension probe before embedding, ` +
      `to respect Voyage's rate limit...\n`,
  );
  await sleep(BATCH_DELAY_MS);

  const batches = chunk(docs, EMBED_BATCH_SIZE);
  process.stdout.write(
    `Embedding ${docs.length} documents in ${batches.length} batches ` +
      `(throttled to stay under Voyage's 3 requests/minute rate limit)...\n`,
  );
  for (let i = 0; i < batches.length; i += 1) {
    process.stdout.write(
      `  Embedding batch ${i + 1}/${batches.length} (${batches[i].length} docs)...\n`,
    );
    await store.addDocuments(batches[i]);

    const isLastBatch = i === batches.length - 1;
    if (!isLastBatch) {
      process.stdout.write(
        `  Waiting ${BATCH_DELAY_MS / 1000}s before next batch to respect Voyage's rate limit...\n`,
      );
      await sleep(BATCH_DELAY_MS);
    }
  }

  process.stdout.write(
    `\nIngested ${docs.length} documents (${probe.length}-dim vectors).\n` +
      `Atlas builds the index asynchronously — allow a few seconds before querying.\n`,
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

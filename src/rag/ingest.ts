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

/** Legacy fallback for documents that do not yet declare an explicit review date. */
const STALE_AFTER_DAYS = 365;

/** Non-blocking — a stale doc still ingests; this only reports it. */
function reportStaleDocs(docs: Document[]): void {
  const staleAfterMs = STALE_AFTER_DAYS * 86_400_000;
  const now = Date.now();
  const stale = docs.filter((d) => {
    const reviewAfter = Date.parse(String(d.metadata.reviewAfter ?? ""));
    if (!Number.isNaN(reviewAfter)) return now > reviewAfter;
    const updated = Date.parse(String(d.metadata.updated));
    return !Number.isNaN(updated) && now - updated > staleAfterMs;
  });
  if (stale.length === 0) return;
  process.stdout.write(`\n${stale.length} document(s) have not been updated in over a year:\n`);
  for (const d of stale) {
    process.stdout.write(`  - ${d.metadata.path} (last updated ${d.metadata.updated})\n`);
  }
  process.stdout.write("\n");
}

/**
 * Atlas Local supports vector search, but the index has to exist before any
 * query runs. Creating it is idempotent — a duplicate name is not an error
 * worth failing the seed over.
 */
async function ensureVectorIndex(collectionName: string, numDimensions: number): Promise<void> {
  const client = await mongoClient();
  const collection = client.db(DB_NAME).collection(collectionName);

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
          { type: "filter", path: "creditPrograms" },
          { type: "filter", path: "cabin" },
          { type: "filter", path: "aircraft" },
          { type: "filter", path: "regions" },
          { type: "filter", path: "airports" },
          { type: "filter", path: "routes" },
          { type: "filter", path: "dimensions" },
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

/**
 * Embeds into a fresh, versioned staging collection and only replaces the
 * live KB_COLLECTION once every batch has succeeded and been verified —
 * via renameCollection's atomic namespace swap, so a reader never observes
 * an empty or partially-embedded live collection. The previous version
 * deleted KB_COLLECTION's contents *before* embedding (which takes several
 * rate-limited minutes); any failure partway left the knowledge base empty
 * until someone reran the whole script successfully.
 */
async function main(): Promise<void> {
  process.stdout.write("Loading knowledge base...\n");
  const docs = await loadDocuments();
  if (docs.length === 0) {
    throw new Error("No knowledge documents found — nothing to ingest.");
  }
  reportStaleDocs(docs);

  const client = await mongoClient();
  const db = client.db(DB_NAME);

  const stagingName = `${KB_COLLECTION}_staging_${Date.now()}`;
  process.stdout.write(`Staging into "${stagingName}" — the live "${KB_COLLECTION}" is untouched until activation.\n`);
  await db.createCollection(stagingName);
  const staging = db.collection(stagingName);

  // voyage-3 emits 1024-dimension vectors. Probe rather than hardcode so a
  // model change does not silently produce an unusable index.
  const store = await getVectorStore(stagingName);
  const probe = await store.embeddings.embedQuery("dimension probe");
  await ensureVectorIndex(stagingName, probe.length);

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
  try {
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
  } catch (err) {
    process.stdout.write(
      `\nEmbedding failed partway through. The live "${KB_COLLECTION}" collection was never touched and ` +
        `is still serving the previous knowledge base. The partially-embedded staging collection ` +
        `"${stagingName}" was left in place for inspection — drop it manually once you're done.\n`,
    );
    throw err;
  }

  const stagedCount = await staging.countDocuments();
  if (stagedCount !== docs.length) {
    throw new Error(
      `Staging validation failed: expected ${docs.length} documents in "${stagingName}", found ${stagedCount}. ` +
        `The live "${KB_COLLECTION}" was not touched.`,
    );
  }

  process.stdout.write(`Validated ${stagedCount} staged documents. Activating...\n`);
  await staging.rename(KB_COLLECTION, { dropTarget: true });
  // Insurance, not the primary mechanism: some Atlas deployments may not
  // carry a search index across a rename. Idempotent — already-exists is
  // not an error — so re-running this against the now-live collection is
  // cheap either way.
  await ensureVectorIndex(KB_COLLECTION, probe.length);

  process.stdout.write(
    `\nIngested ${docs.length} documents (${probe.length}-dim vectors) into "${KB_COLLECTION}".\n` +
      `Atlas builds the index asynchronously — allow a few seconds before querying.\n`,
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

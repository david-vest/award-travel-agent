import { Document } from "@langchain/core/documents";
import { VoyageEmbeddings } from "@langchain/community/embeddings/voyage";
import { MongoDBAtlasVectorSearch } from "@langchain/mongodb";
import { MongoClient } from "mongodb";
import type { KbFrontmatter } from "./frontmatter";

export const DB_NAME = "award_travel";
export const KB_COLLECTION = "kb_documents";
export const VECTOR_INDEX_NAME = "kb_vector_index";

export function embeddings(): VoyageEmbeddings {
  return new VoyageEmbeddings({
    apiKey: process.env.VOYAGE_API_KEY,
    modelName: "voyage-4",
  });
}

/**
 * One document per concept. No text splitting: these are already atomic, and
 * splitting a 300-word sweet-spot note routinely separates a claim from the
 * caveat that makes it actionable.
 */
export function toDocument(
  fm: KbFrontmatter | (Omit<KbFrontmatter, "airports" | "routes" | "dimensions" | "creditPrograms"> & Partial<Pick<KbFrontmatter, "airports" | "routes" | "dimensions" | "creditPrograms">>),
  body: string,
  filePath: string,
): Document {
  return new Document({
    pageContent: body,
    metadata: {
      id: fm.id,
      collection: fm.collection,
      // Uppercased so a query-time filter never has to worry about casing.
      airlines: fm.airlines.map((a) => a.toUpperCase()),
      aircraft: fm.aircraft,
      programs: fm.programs.map((p) => p.toLowerCase()),
      creditPrograms: (fm.creditPrograms ?? []).map((program) => program.toLowerCase()),
      regions: fm.regions,
      airports: (fm.airports ?? []).map((airport) => airport.toUpperCase()),
      routes: (fm.routes ?? []).map((route) => route.toUpperCase()),
      dimensions: fm.dimensions ?? [],
      cabin: fm.cabin ?? null,
      productName: fm.productName ?? null,
      updated: fm.updated,
      reviewAfter: fm.reviewAfter ?? null,
      sources: fm.sources,
      path: filePath,
    },
  });
}

/** Exact metadata lookup used before semantic retrieval for ranking evidence. */
export async function findKnowledgeDocuments(
  filter: Record<string, unknown>,
  limit: number = 80,
): Promise<Document[]> {
  const client = await mongoClient();
  const rows = await client
    .db(DB_NAME)
    .collection(KB_COLLECTION)
    .find(filter, { projection: { embedding: 0 } })
    .limit(limit)
    .toArray();

  return rows.map((row) => new Document({
    pageContent: String(row.text ?? ""),
    metadata: Object.fromEntries(
      Object.entries(row).filter(([key]) => !["_id", "text"].includes(key)),
    ),
  }));
}

let cachedClient: MongoClient | undefined;

export async function mongoClient(): Promise<MongoClient> {
  if (!cachedClient) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI is not set");
    cachedClient = new MongoClient(uri);
    await cachedClient.connect();
  }
  return cachedClient;
}

/** `collectionName` defaults to the live KB — ingest.ts overrides it to target a staging collection while re-embedding. */
export async function getVectorStore(
  collectionName: string = KB_COLLECTION,
): Promise<MongoDBAtlasVectorSearch> {
  const client = await mongoClient();
  const collection = client.db(DB_NAME).collection(collectionName);

  return new MongoDBAtlasVectorSearch(embeddings(), {
    collection,
    indexName: VECTOR_INDEX_NAME,
    textKey: "text",
    embeddingKey: "embedding",
  });
}

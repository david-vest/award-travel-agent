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
  fm: KbFrontmatter,
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
      regions: fm.regions,
      cabin: fm.cabin ?? null,
      updated: fm.updated,
      sources: fm.sources,
      path: filePath,
    },
  });
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

export async function getVectorStore(): Promise<MongoDBAtlasVectorSearch> {
  const client = await mongoClient();
  const collection = client.db(DB_NAME).collection(KB_COLLECTION);

  return new MongoDBAtlasVectorSearch(embeddings(), {
    collection,
    indexName: VECTOR_INDEX_NAME,
    textKey: "text",
    embeddingKey: "embedding",
  });
}

import { mongoClient, getVectorStore, DB_NAME } from "../../../src/rag/store";

export const runtime = "nodejs";

type DependencyStatus = "ok" | "unreachable";

async function checkMongo(): Promise<DependencyStatus> {
  try {
    const client = await mongoClient();
    await client.db(DB_NAME).command({ ping: 1 });
    return "ok";
  } catch {
    return "unreachable";
  }
}

/**
 * Constructing the store is a reasonable liveness signal on its own — an
 * actual query would cost a Voyage embedding call on every health check,
 * which is wasteful for something meant to run frequently.
 */
async function checkRag(): Promise<DependencyStatus> {
  try {
    await getVectorStore();
    return "ok";
  } catch {
    return "unreachable";
  }
}

export async function GET(): Promise<Response> {
  const [mongo, rag] = await Promise.allSettled([checkMongo(), checkRag()]);

  const mongoStatus: DependencyStatus = mongo.status === "fulfilled" ? mongo.value : "unreachable";
  const ragStatus: DependencyStatus = rag.status === "fulfilled" ? rag.value : "unreachable";

  // Replay is a valid, intentional configuration (no paid key on file), not
  // a degraded one — informational only, never fails the health check.
  const seatsAeroMode = process.env.SEATS_AERO_API_KEY ? "live" : "replay";

  // Mongo is the only hard dependency for this health check — the RAG store
  // degrades gracefully elsewhere in the app (retrieve.ts) when unavailable.
  const healthy = mongoStatus === "ok";

  return Response.json(
    { mongo: mongoStatus, rag: ragStatus, seatsAero: { mode: seatsAeroMode } },
    { status: healthy ? 200 : 503 },
  );
}

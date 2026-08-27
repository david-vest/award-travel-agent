import { agentFeedbackSchema } from "../../../../src/contracts/travel-search";
import { recordAgentFeedback } from "../../../../src/observability/user-feedback";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!/^application\/json(;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return Response.json({ error: "Content-Type must be application/json." }, { status: 415 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON request body." }, { status: 400 });
  }

  const parsed = agentFeedbackSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid feedback." }, { status: 400 });
  }

  try {
    await recordAgentFeedback(parsed.data);
    return Response.json({ saved: true });
  } catch (error) {
    console.error("agent feedback failed", error);
    return Response.json({ error: "Feedback could not be saved." }, { status: 502 });
  }
}

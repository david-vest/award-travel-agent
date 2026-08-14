// src/agent/nodes/degrade.ts
import type { AgentStateType } from "../state";

/**
 * Terminal fallback after the retry budget is spent. No model call — a model
 * that has already produced two ungrounded drafts is not the right tool for
 * writing the apology. Emit what the data actually supports and say plainly
 * that the details could not be verified.
 */
export async function degrade(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const options = (state.awardResults ?? []).slice(0, 5);
  const docs = state.kbDocs ?? [];

  // The knowledge branch (triage -> retrieve_knowledge -> synthesize) never
  // runs a search, so it never has awardResults to fall back on — but it DID
  // retrieve real KB excerpts. The generic "no award availability" apology
  // below is about search, not knowledge, and is actively wrong/irrelevant
  // here: surface what was actually retrieved instead.
  if (options.length === 0 && docs.length > 0) {
    const lines = docs.slice(0, 5).map((d) => `- ${d.text}`);
    return {
      draft: [
        "I found relevant information but could not fully verify a " +
          "synthesized answer, so here is what the knowledge base says:",
        "",
        ...lines,
      ].join("\n"),
    };
  }

  if (options.length === 0) {
    return {
      draft:
        "I could not find award availability matching that search, and I was " +
        "not able to produce a verified answer. Try a wider date range, a " +
        "nearby airport, or a different cabin.",
    };
  }

  const lines = options.map(
    (o) =>
      `- ${o.origin} → ${o.destination} on ${o.date}: ${o.miles.toLocaleString()} ` +
      `miles in ${o.cabin} via ${o.program}` +
      `${o.direct ? " (nonstop)" : ""}` +
      `${o.airlines ? ` on ${o.airlines}` : ""}`,
  );

  return {
    draft: [
      "Here is exactly what the availability data shows. I was not able to " +
        "verify a fuller write-up, so this is the raw result rather than a " +
        "recommendation:",
      "",
      ...lines,
      "",
      "Availability is cached and can change quickly — confirm with the " +
        "program before transferring any points.",
    ].join("\n"),
  };
}

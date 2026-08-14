import { z } from "zod";
import { chat } from "../models";
import { plainSystem } from "../cache";
import { GUARD_PROMPT } from "../prompts/guard";
import type { AgentStateType } from "../state";
import { lastUserText } from "./triage";

export const guardSchema = z.object({
  allowed: z.boolean().describe("Whether this message should be processed"),
  reason: z
    .string()
    .describe("If not allowed, one short actionable sentence for the user"),
});

/**
 * Search-derived state from a prior turn must not leak into a new turn.
 * guardInput runs first on every turn (guard_input is the graph's entry
 * node), and the knowledge branch (triage -> retrieve_knowledge ->
 * synthesize) never writes these channels itself — so with the production
 * MongoDBSaver checkpointer restoring full thread state, a turn that doesn't
 * search would otherwise inherit the previous turn's awardResults,
 * tripSummaries, and searchPlan wholesale. Spread onto every return path
 * below so a new turn always starts clean. refusalReason defaults to null
 * here too — only the explicit-rejection path below overrides it with a
 * real reason, by spreading this first and setting refusalReason after.
 */
const RESET_TURN_STATE: Partial<AgentStateType> = {
  searchPlan: null,
  awardResults: [],
  tripSummaries: [],
  kbDocs: [],
  draft: null,
  violations: [],
  refusalReason: null,
};

export async function guardInput(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const text = lastUserText(state);

  // Nothing to screen. Let triage deal with the empty case.
  if (text.trim().length === 0) return { ...RESET_TURN_STATE, intent: null };

  const model = chat({ effort: "low", disableThinking: true }).withStructuredOutput(
    guardSchema,
    { name: "guard_decision" },
  );

  // thinking:"adaptive" + withStructuredOutput's forced tool calling don't
  // always compose cleanly (see models.ts). A guard failure should not block
  // a legitimate user over a transient infra hiccup — this is a travel
  // concierge, not a security-critical system, so fail OPEN.
  try {
    const result = await model.invoke([
      plainSystem(GUARD_PROMPT),
      { role: "user", content: text },
    ]);

    return result.allowed
      ? { ...RESET_TURN_STATE, intent: null, refusalReason: null }
      : { ...RESET_TURN_STATE, intent: "rejected", refusalReason: result.reason };
  } catch {
    return { ...RESET_TURN_STATE, intent: null, refusalReason: null };
  }
}

/** Terminal node for rejected input. No model call — the guard already wrote it. */
export async function refuse(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  return {
    draft:
      state.refusalReason ??
      "I can only help with award travel — flights, points, and mileage programs.",
  };
}

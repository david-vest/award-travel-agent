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
 *
 * revisionCount and refreshedAt (added in Phase 5) must reset here too, for
 * the same cross-turn-leak reason: without a reset, a stale revisionCount
 * would eat into the next turn's retry budget, and a stale refreshedAt would
 * make a turn that never refreshed falsely claim it re-confirmed with the
 * provider.
 */
const RESET_TURN_STATE: Partial<AgentStateType> = {
  searchPlan: null,
  awardResults: [],
  tripSummaries: [],
  recommendations: [],
  locationResolutions: [],
  searchAttempts: [],
  positioningSearchComplete: false,
  kbDocs: [],
  draft: null,
  violations: [],
  refusalReason: null,
  refreshedAt: null,
};

export async function guardInput(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const text = lastUserText(state);

  // revisionCount uses an ADDITIVE reducer (current + update), unlike the
  // other RESET_TURN_STATE fields above which simply replace. Returning a
  // static `revisionCount: 0` would be a no-op (current + 0 = current) and
  // would NOT reset anything — the count would silently carry over from the
  // prior turn via the checkpointer. To actually zero it out, we have to
  // return the negation of whatever the incoming (restored) value is, so
  // current + (-current) = 0.
  const resetTurnState: Partial<AgentStateType> = {
    ...RESET_TURN_STATE,
    // `state.revisionCount ? -state.revisionCount : 0` rather than
    // `-(state.revisionCount ?? 0)` — the latter produces -0 when the
    // incoming count is already 0, and -0 fails strict (Object.is) equality
    // checks against 0 in tests even though it's numerically identical.
    revisionCount: state.revisionCount ? -state.revisionCount : 0,
  };

  // Form input is validated and bounded at the API boundary, so it does not
  // need an LLM call just to establish that this is an award-travel search.
  if (state.tripRequest) return { ...resetTurnState, intent: null, refusalReason: null };

  // Nothing to screen. Let triage deal with the empty case.
  if (text.trim().length === 0) return { ...resetTurnState, intent: null };

  // thinking:"adaptive" + withStructuredOutput's forced tool calling don't
  // always compose cleanly (see models.ts). A guard failure should not block
  // a legitimate user over a transient infra hiccup — this is a travel
  // concierge, not a security-critical system, so fail OPEN.
  try {
    const model = chat({ effort: "low", disableThinking: true }).withStructuredOutput(
      guardSchema,
      { name: "guard_decision" },
    );
    const result = await model.invoke([
      plainSystem(GUARD_PROMPT),
      { role: "user", content: text },
    ]);

    return result.allowed
      ? { ...resetTurnState, intent: null, refusalReason: null }
      : { ...resetTurnState, intent: "rejected", refusalReason: result.reason };
  } catch {
    return { ...resetTurnState, intent: null, refusalReason: null };
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

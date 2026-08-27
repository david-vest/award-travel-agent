import { z } from "zod";
import { chat } from "../models";
import { plainSystem } from "../cache";
import { GUARD_PROMPT } from "../prompts/guard";
import type { AgentStateType } from "../state";
import { lastUserText } from "./triage";
import { defaultRecommendationPreferences } from "../../domain/recommendation-preferences";

export const guardSchema = z.object({
  allowed: z.boolean().describe("Whether this message should be processed"),
  reason: z
    .string()
    .describe("If not allowed, one short actionable sentence for the user"),
});

/**
 * Search-derived state from a prior turn must not leak into a new turn that
 * doesn't search. guardInput runs first on every turn (guard_input is the
 * graph's entry node), and the knowledge branch (triage -> retrieve_knowledge
 * -> synthesize) never writes these channels itself — so with the production
 * MongoDBSaver checkpointer restoring full thread state, a turn that doesn't
 * search would otherwise inherit the previous turn's awardResults and
 * tripSummaries wholesale. Spread onto every return path below so a new turn
 * always starts clean. refusalReason defaults to null here too — only the
 * explicit-rejection path below overrides it with a real reason, by
 * spreading this first and setting refusalReason after.
 *
 * searchPlan is deliberately NOT reset here, unlike the fields above. Unlike
 * awardResults/tripSummaries (raw search output, genuinely stale once a new
 * turn starts), searchPlan is the conversation's short-term memory of trip
 * criteria (origin, destination, dates, cabin) — it needs to survive a turn
 * that doesn't search at all (e.g. "only business or first", which names no
 * new origin/destination) so plan-search/plan-discovery can carry it forward
 * via searchPlan's merge reducer (state.ts). Resetting it here would erase
 * that memory before triage has even determined whether this turn searches.
 *
 * revisionCount and refreshedAt (added in Phase 5) must reset here too, for
 * the same cross-turn-leak reason as awardResults/tripSummaries: without a
 * reset, a stale revisionCount would eat into the next turn's retry budget,
 * and a stale refreshedAt would make a turn that never refreshed falsely
 * claim it re-confirmed with the provider. degradedReasons resets for the
 * same reason — a dependency outage from three turns ago must not tag an
 * unrelated later turn as degraded.
 */
const RESET_TURN_STATE: Partial<AgentStateType> = {
  awardResults: [],
  candidateShortlist: [],
  searchStatus: "not_run",
  tripSummaries: [],
  recommendations: [],
  locationResolutions: [],
  searchAttempts: [],
  positioningSearchComplete: false,
  kbDocs: [],
  optionEvidence: {},
  candidateAssessments: {},
  draft: null,
  violations: [],
  refusalReason: null,
  refreshedAt: null,
  degradedReasons: [],
  clarificationResolution: null,
};

/**
 * Keep only high-confidence denials in code. Ambiguous language should reach
 * the travel graph, especially on a follow-up turn where "the second one" or
 * "best seat" is meaningful only because a recommendation snapshot exists.
 */
export function obviousGuardRejection(text: string): string | null {
  const promptAttack = /\b(?:ignore|override|bypass|reveal|show|print|repeat|leak|extract)\b.{0,60}\b(?:instructions?|system prompt|developer message|hidden prompt|secrets?|credentials?|api keys?|environment variables?)\b/i.test(text)
    || /\b(?:system prompt|developer message|hidden instructions?)\b.{0,60}\b(?:reveal|show|print|repeat|leak|extract)\b/i.test(text)
    || /\b(?:read|open|access|dump|exfiltrate|send|list|give me|what are)\b.{0,50}\b(?:\.env|ssh keys?|passwords?|secrets?|credentials?|api keys?|environment variables?)\b/i.test(text);
  if (promptAttack) {
    return "I can’t reveal or override system instructions, but I can help with award travel.";
  }

  const codeTask = /\b(?:write|build|debug|fix|refactor|implement|compile|execute|run)\b.{0,40}\b(?:code|script|program|function|sql|regex|python|javascript|typescript|java|c\+\+|html|css)\b/i.test(text)
    || /\b(?:code|programming|software)\s+(?:question|homework|assignment)\b/i.test(text);
  const mathHomework = /\b(?:math|algebra|geometry|calculus|trigonometry|statistics)\s+(?:homework|problem|assignment|question)\b/i.test(text)
    || /\b(?:solve|differentiate|integrate|factor)\b.{0,30}\b(?:equation|polynomial|derivative|integral|for\s+x)\b/i.test(text)
    || /^\s*what(?:'s| is)\s+[-+*/().\d\s]+\??\s*$/i.test(text);
  const clearlyUnrelated = /\b(?:write me|tell me|give me)\b.{0,25}\b(?:joke|poem|recipe|cover letter|short story)\b/i.test(text)
    || /\b(?:diagnose|medical advice|legal advice|lawsuit|tax advice)\b/i.test(text);

  if (codeTask || mathHomework || clearlyUnrelated) {
    return "I can only help with award travel, flights, points, and mileage programs.";
  }
  return null;
}

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
    recommendationPreferences: defaultRecommendationPreferences(),
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

  const obviousRejection = obviousGuardRejection(text);
  if (obviousRejection) {
    return { ...resetTurnState, intent: "rejected", refusalReason: obviousRejection };
  }

  // Once a verified recommendation snapshot exists, short and ambiguous
  // phrases are normal conversation, not suspicious input. Triage has the
  // context needed to decide whether the user wants a rerank, explanation, or
  // fresh search. Avoid spending a guard-model call that sees only the phrase
  // and tends to reject useful requests such as "best seat" or "why not #2?".
  if (state.recommendationSnapshot) {
    return { ...resetTurnState, intent: null, refusalReason: null };
  }

  // thinking:"adaptive" + withStructuredOutput's forced tool calling don't
  // always compose cleanly (see models.ts). A guard failure should not block
  // a legitimate user over a transient infra hiccup — this is a travel
  // concierge, not a security-critical system, so fail OPEN.
  try {
    // Haiku, not Sonnet: this is a cheap allow/reject classification, not a
    // reasoning task, and it runs on every single turn.
    const model = chat({
      model: "haiku",
      effort: "low",
      maxTokens: 256,
      disableThinking: true,
    }).withStructuredOutput(guardSchema, { name: "guard_decision" });
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

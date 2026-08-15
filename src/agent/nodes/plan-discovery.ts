// src/agent/nodes/plan-discovery.ts
import { z } from "zod";
import { chat } from "../models";
import { plainSystem } from "../cache";
import { DISCOVERY_PROMPT } from "../prompts/plan-discovery";
import { resolveLocation } from "../../tools/locations/resolve";
import { REGIONS } from "../../tools/seats-aero/types";
import type { AgentStateType, AgentStateUpdate, DiscoveryProbe, SearchPlan } from "../state";
import { lastUserText, conversationContext } from "./triage";

/** Hard cap on tool calls for one open-ended question. Protects daily quota. */
export const DISCOVERY_BUDGET = 6;

// Must match state.ts's mergeSearchPlan reducer fallback (and
// plan-search.ts's own DEFAULT_WINDOW_DAYS) — the prompt below states this
// default to the model, but the reducer is what actually applies it when the
// current turn omits dates, so the two must stay in lockstep.
const DEFAULT_WINDOW_DAYS = 60;

export const discoveryPlanSchema = z.object({
  origin: z
    .string()
    .optional()
    .describe(
      "Origin city or airport the user named. Omit entirely if the " +
        "current message doesn't address origin — the system carries " +
        "forward whatever an earlier turn already established.",
    ),
  probes: z
    .array(
      z.object({
        program: z.string().describe('One mileage program, e.g. "aeroplan"'),
        destinationRegion: z.enum(REGIONS as unknown as [string, ...string[]]),
        cabin: z.enum(["economy", "premium", "business", "first"]),
      }),
    )
    .describe("Ordered most-promising first. Only the first six will run."),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  rationale: z.string().optional(),
});

/**
 * Enforced in code rather than requested in the prompt. "At most six" in a
 * system prompt is a suggestion; slice is a guarantee, and this node is what
 * stands between one vague question and a day's worth of API quota.
 */
export function capProbes<T>(probes: T[], budget: number = DISCOVERY_BUDGET): T[] {
  return probes.slice(0, budget);
}

export async function planDiscovery(state: AgentStateType): Promise<AgentStateUpdate> {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const defaultEnd = new Date(now.getTime() + DEFAULT_WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const priorContext = await conversationContext(state);

  const model = chat({ effort: "low", disableThinking: true }).withStructuredOutput(
    discoveryPlanSchema,
    { name: "discovery_plan" },
  );

  const raw = await model.invoke([
    plainSystem(DISCOVERY_PROMPT),
    {
      role: "user",
      content: [
        `Today's date is ${today}.`,
        `If the current message states or implies timing, resolve it relative ` +
          `to ${today}. The system applies a default window of ${today} ` +
          `through ${defaultEnd} automatically when the current message says ` +
          `nothing about timing, so omit startDate/endDate entirely in that case.`,
        `At most ${DISCOVERY_BUDGET} probes will be executed.`,
        ...(priorContext ? ["", "Earlier in this conversation:", priorContext] : []),
        "",
        "Request:",
        lastUserText(state),
      ].join("\n"),
    },
  ]);

  // A sticky cabin restriction from a prior turn is enforced here in code,
  // not just requested in the prompt — mirrors capProbes's own philosophy
  // ("'At most six' in a system prompt is a suggestion; slice is a
  // guarantee"). Filtering the probe list itself (rather than only the
  // summary `cabins` field below) also means a probe outside the restriction
  // never actually runs, not just that it's hidden from display.
  //
  // `searchPlan.cabins` is ambiguous about where it came from: plan-search.ts
  // only sets it when the user explicitly states/changes a cabin preference
  // (a real restriction worth being sticky about), but planDiscovery itself
  // always sets it below as an auto-derived SUMMARY of whatever cabins that
  // turn's own probes happened to cover — never a stated preference. Treating
  // that summary as a sticky restriction for a LATER discovery turn would
  // silently bootstrap a constraint the user never asked for. A prior plan
  // that itself has `discoveryProbes` came from a discovery turn, so its
  // `cabins` is that auto-derived summary, not a real restriction — only
  // treat `cabins` as sticky when the prior plan has no `discoveryProbes`
  // (i.e. it came from a route_search turn).
  const priorPlanIsFromDiscovery = (state.searchPlan?.discoveryProbes?.length ?? 0) > 0;
  const stickyCabins = priorPlanIsFromDiscovery ? [] : (state.searchPlan?.cabins ?? []);
  const filteredProbes =
    stickyCabins.length > 0
      ? raw.probes.filter((p) => stickyCabins.includes(p.cabin))
      : raw.probes;
  // Escape hatch: if the sticky restriction would zero out every probe the
  // model proposed, that's a signal the current turn is asking about a
  // genuinely different cabin (e.g. "what about economy?" after a prior
  // business-only turn), not that zero probes should run. Falling back to the
  // unfiltered list lets the current turn's own signal win rather than
  // returning a misleading "could not resolve" answer from an empty
  // discoveryProbes list.
  const rawProbes =
    filteredProbes.length === 0 && raw.probes.length > 0 ? raw.probes : filteredProbes;
  const probes = capProbes(rawProbes);

  // Unresolved/ambiguous origins are collected rather than silently dropped —
  // mirrors plan-search.ts's expand(). Only resolved (and origins set at
  // all) when the current turn actually names one; omitted entirely
  // otherwise so a follow-up like "only business or first" doesn't collapse
  // an already-established origin back to nothing.
  let origins: string[] | undefined;
  let unresolvedPlaces: string[] | undefined;
  let ambiguousPlaces: { query: string; candidates: string[] }[] | undefined;
  if (raw.origin) {
    const origin = resolveLocation(raw.origin);
    if (origin.kind === "airports") origins = origin.iatas;
    else if (origin.kind === "region") origins = origin.representativeIatas;
    else if (origin.kind === "unknown") {
      origins = [];
      unresolvedPlaces = [raw.origin];
    } else if (origin.kind === "ambiguous") {
      origins = [];
      ambiguousPlaces = [{ query: origin.query, candidates: origin.candidates }];
    }
  }

  // Discovery reuses SearchPlan so downstream nodes see one shape.
  // `destinations` and `nonstopOnly` are deliberately omitted, not forced to
  // `[]`/`false` — discovery never targets specific cities or a nonstop
  // constraint itself, but a prior route_search turn's values for those
  // fields should survive in case the conversation swings back to a precise
  // search later (search_awards's discovery branch doesn't read either
  // field, so leaving them be doesn't change this turn's own probes).
  // `discoveryProbes` carries the real, ordered probe list verbatim; the
  // flattened programs/cabins/destinationRegion fields below are a summary
  // for display and logging only — search_awards must read discoveryProbes
  // via probesFromPlan, never reconstruct probes from them.
  const plan: Partial<SearchPlan> = {
    origins,
    destinationRegion: probes[0]?.destinationRegion,
    startDate: raw.startDate,
    endDate: raw.endDate,
    cabins: probes.length > 0 ? [...new Set(probes.map((p) => p.cabin))] : undefined,
    programs: probes.length > 0 ? [...new Set(probes.map((p) => p.program))] : undefined,
    rationale: raw.rationale,
    unresolvedPlaces,
    ambiguousPlaces,
    discoveryProbes: probes,
  };

  // Drop undefined-valued keys entirely rather than leaving them present —
  // matches plan-search.ts's convention. See that file's comment for why
  // this is safe under the merge reducer.
  for (const key of Object.keys(plan) as (keyof typeof plan)[]) {
    if (plan[key] === undefined) delete plan[key];
  }

  return { searchPlan: plan };
}

/**
 * Returns the plan's real probe list. This is a plain accessor, not a
 * reconstruction — the probes were already chosen by the model and capped
 * once, in planDiscovery, and are carried on the plan verbatim precisely so
 * this function doesn't have to guess at them from flattened summary fields.
 */
export function probesFromPlan(plan: SearchPlan): DiscoveryProbe[] {
  return capProbes(plan.discoveryProbes ?? []);
}

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

const DEFAULT_WINDOW_DAYS = 90;

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
        `If the user gives no timing, consider ${today} through ${defaultEnd}.`,
        `At most ${DISCOVERY_BUDGET} probes will be executed.`,
        ...(priorContext ? ["", "Earlier in this conversation:", priorContext] : []),
        "",
        "Request:",
        lastUserText(state),
      ].join("\n"),
    },
  ]);

  const probes = capProbes(raw.probes);

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

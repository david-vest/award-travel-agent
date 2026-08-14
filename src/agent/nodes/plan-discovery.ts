// src/agent/nodes/plan-discovery.ts
import { z } from "zod";
import { chat } from "../models";
import { plainSystem } from "../cache";
import { DISCOVERY_PROMPT } from "../prompts/plan-discovery";
import { resolveLocation } from "../../tools/locations/resolve";
import { REGIONS } from "../../tools/seats-aero/types";
import type { AgentStateType, DiscoveryProbe, SearchPlan } from "../state";
import { lastUserText } from "./triage";

/** Hard cap on tool calls for one open-ended question. Protects daily quota. */
export const DISCOVERY_BUDGET = 6;

const DEFAULT_WINDOW_DAYS = 90;

export const discoveryPlanSchema = z.object({
  origin: z.string().min(1).describe("Origin city or airport the user named"),
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

export async function planDiscovery(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const defaultEnd = new Date(now.getTime() + DEFAULT_WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

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
        "",
        "Request:",
        lastUserText(state),
      ].join("\n"),
    },
  ]);

  const probes = capProbes(raw.probes);
  const origin = resolveLocation(raw.origin);
  const origins =
    origin.kind === "airports"
      ? origin.iatas
      : origin.kind === "region"
        ? origin.representativeIatas
        : [];

  // Unresolved/ambiguous origins are collected rather than silently dropped —
  // mirrors plan-search.ts's expand(), so synthesize (Task 4.7) can tell the
  // user "I didn't recognize X" instead of the search silently coming back
  // empty. Only set when non-empty, matching plan-search.ts's style.
  const unresolvedPlaces = origin.kind === "unknown" ? [raw.origin] : undefined;
  const ambiguousPlaces =
    origin.kind === "ambiguous"
      ? [{ query: origin.query, candidates: origin.candidates }]
      : undefined;

  // Discovery reuses SearchPlan so downstream nodes see one shape.
  // `discoveryProbes` carries the real, ordered probe list verbatim; the
  // flattened programs/cabins/destinationRegion fields below are a summary
  // for display and logging only — search_awards (Task 4.6) must read
  // discoveryProbes via probesFromPlan, never reconstruct probes from them.
  const plan: SearchPlan = {
    origins,
    destinations: [],
    destinationRegion: probes[0]?.destinationRegion,
    startDate: raw.startDate ?? today,
    endDate: raw.endDate ?? defaultEnd,
    cabins: [...new Set(probes.map((p) => p.cabin))],
    nonstopOnly: false,
    programs: [...new Set(probes.map((p) => p.program))],
    rationale: raw.rationale,
    unresolvedPlaces,
    ambiguousPlaces,
    discoveryProbes: probes,
  };

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

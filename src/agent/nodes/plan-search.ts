import { z } from "zod";
import { chat } from "../models";
import { cachedSystem } from "../cache";
import { PLAN_SEARCH_PROMPT } from "../prompts/plan-search";
import { resolveLocation } from "../../tools/locations/resolve";
import {
  inferMultiCityRoute,
  searchCodeForRegion,
} from "../../tools/seats-aero/multi-city-codes";
import { MILEAGE_PROGRAMS, REGIONS } from "../../tools/seats-aero/types";
import type { AgentStateType, AgentStateUpdate, SearchPlan } from "../state";
import { lastUserText, conversationContext } from "./triage";

const DEFAULT_WINDOW_DAYS = 60;

export const searchPlanSchema = z.object({
  origins: z
    .array(z.string())
    .optional()
    .describe(
      "Origin cities or airport codes as the user expressed them. Omit " +
        "entirely if the current message doesn't address origin — the " +
        "system carries forward whatever an earlier turn established.",
    ),
  destinations: z
    .array(z.string())
    .optional()
    .describe(
      "Destination cities/airports, or an empty list when the request " +
        "names a region instead. Omit entirely if the current message " +
        "doesn't address destination at all.",
    ),
  destinationRegion: z
    .enum(REGIONS as unknown as [string, ...string[]])
    .optional()
    .describe("One of the six seats.aero regions, if the user named a region"),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  cabins: z
    .array(z.enum(["economy", "premium", "business", "first"]))
    .optional()
    .describe(
      "Only when the current message states or changes a cabin preference.",
    ),
  nonstopOnly: z.boolean().optional(),
  programs: z
    .array(z.string())
    .optional()
    .describe(
      "Programs explicitly requested by the user, or [] for a complete route request with no program constraint.",
    ),
  rationale: z.string().optional(),
});

/**
 * Everything volatile lives here, in the user turn — today's date above all.
 * Putting it in the (cached) system prompt would invalidate the prefix daily.
 * `priorContext` (optional, trailing) carries earlier turns forward for a
 * follow-up message — e.g. "actually nonstop only" needs the origin/
 * destination/dates a prior turn already established. It comes from
 * triage.ts's `conversationContext`, the same convention triage's own
 * prompt already uses, so this doesn't duplicate that logic.
 */
export function buildPlannerContext(
  userText: string,
  now: Date,
  priorContext = "",
): string {
  const today = now.toISOString().slice(0, 10);
  const defaultEnd = new Date(now.getTime() + DEFAULT_WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const lines = [
    `Today's date is ${today}. The current year is ${now.getUTCFullYear()}.`,
    `If the user gives no timing, search ${today} through ${defaultEnd}.`,
  ];

  if (priorContext) {
    lines.push("", "Earlier in this conversation:", priorContext);
  }

  lines.push("", "Request:", userText);

  return lines.join("\n");
}

export async function planSearch(
  state: AgentStateType,
  now: Date = new Date(),
): Promise<AgentStateUpdate> {
  const model = chat({
    effort: "low",
    maxTokens: 1_200,
    disableThinking: true,
  }).withStructuredOutput(searchPlanSchema, { name: "search_plan" });

  const priorContext = await conversationContext(state);
  const userText = lastUserText(state);
  const plannerContext = buildPlannerContext(userText, now, priorContext);
  const plannerMessages = [
    cachedSystem(PLAN_SEARCH_PROMPT),
    {
      role: "user" as const,
      content: plannerContext,
    },
  ];
  let raw = await model.invoke(plannerMessages);
  const inferredRoute = inferMultiCityRoute(userText);

  // The observed LangSmith failure returned {} for a complete, explicit route.
  // Retry the inexpensive planning step once so cabins/dates are recovered too;
  // the deterministic endpoint inference below still guarantees a search if
  // the retry is also incomplete.
  if (
    raw.origins === undefined &&
    raw.destinations === undefined &&
    inferredRoute.origins.length > 0 &&
    inferredRoute.destinations.length > 0
  ) {
    raw = await model.invoke([
      cachedSystem(PLAN_SEARCH_PROMPT),
      {
        role: "user",
        content:
          `${plannerContext}\n\n` +
          "Retry: the request explicitly contains searchable origin and destination " +
          "multi-city areas. Return the complete structured plan; do not omit them.",
      },
    ]);
  }

  const rawOrigins =
    raw.origins && raw.origins.length > 0
      ? raw.origins
      : inferredRoute.origins.length > 0
        ? inferredRoute.origins
        : raw.origins;
  const rawDestinations =
    raw.destinations && raw.destinations.length > 0
      ? raw.destinations
      : inferredRoute.destinations.length > 0
        ? inferredRoute.destinations
        : raw.destinations;

  // Expand place names deterministically, only when this turn actually named
  // them. Presence — even an empty list — means "this turn's answer";
  // omission means "carry forward the prior plan's value," which is
  // searchPlan's merge reducer's job (state.ts), not this node's.
  const originsResult = rawOrigins !== undefined ? expand(rawOrigins) : undefined;
  const destinationsResult =
    rawDestinations !== undefined ? expand(rawDestinations) : undefined;
  // A broad region on a route request should use seats.aero's own multi-city
  // code when one exists. In particular, Europe -> EUR turns USA -> Europe
  // into the valid cached-search pair USA -> EUR rather than an empty
  // destination list that causes search.ts to return before calling the API.
  if (
    destinationsResult &&
    destinationsResult.codes.length === 0 &&
    raw.destinationRegion
  ) {
    const code = searchCodeForRegion(raw.destinationRegion);
    if (code) destinationsResult.codes.push(code);
  }
  const unresolvedPlaces = [
    ...(originsResult?.unresolved ?? []),
    ...(destinationsResult?.unresolved ?? []),
  ];
  const ambiguousPlaces = [
    ...(originsResult?.ambiguous ?? []),
    ...(destinationsResult?.ambiguous ?? []),
  ];

  const plan: Partial<SearchPlan> = {
    origins: originsResult?.codes,
    destinations: destinationsResult?.codes,
    destinationRegion: raw.destinationRegion,
    startDate: raw.startDate,
    endDate: raw.endDate,
    cabins: raw.cabins,
    nonstopOnly: raw.nonstopOnly,
    programs: raw.programs?.filter((program) =>
      (MILEAGE_PROGRAMS as readonly string[]).includes(program),
    ),
    rationale: raw.rationale,
    unresolvedPlaces: unresolvedPlaces.length > 0 ? unresolvedPlaces : undefined,
    ambiguousPlaces: ambiguousPlaces.length > 0 ? ambiguousPlaces : undefined,
  };

  // Drop undefined-valued keys entirely rather than leaving them present.
  // The merge reducer treats "present with undefined" the same as "absent"
  // either way (both read as undefined through optional chaining), but an
  // omitted turn should produce a plan object that doesn't even list the
  // field it didn't touch.
  for (const key of Object.keys(plan) as (keyof typeof plan)[]) {
    if (plan[key] === undefined) delete plan[key];
  }

  return { searchPlan: plan };
}

type ExpansionResult = {
  codes: string[];
  unresolved: string[];
  ambiguous: { query: string; candidates: string[] }[];
};

function expand(names: string[]): ExpansionResult {
  const codes = new Set<string>();
  const unresolved: string[] = [];
  const ambiguous: { query: string; candidates: string[] }[] = [];

  for (const name of names) {
    const r = resolveLocation(name);
    if (r.kind === "airports") r.iatas.forEach((i) => codes.add(i));
    else if (r.kind === "region") {
      const searchCode = searchCodeForRegion(r.region);
      if (searchCode) codes.add(searchCode);
      else r.representativeIatas.forEach((i) => codes.add(i));
    }
    else if (r.kind === "ambiguous") ambiguous.push({ query: r.query, candidates: r.candidates });
    else unresolved.push(r.query); // kind === "unknown"
  }

  return { codes: [...codes], unresolved, ambiguous };
}

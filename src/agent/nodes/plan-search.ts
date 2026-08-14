import { z } from "zod";
import { chat } from "../models";
import { cachedSystem } from "../cache";
import { PLAN_SEARCH_PROMPT } from "../prompts/plan-search";
import { resolveLocation } from "../../tools/locations/resolve";
import type { AgentStateType, SearchPlan } from "../state";
import { lastUserText, conversationContext } from "./triage";

const DEFAULT_WINDOW_DAYS = 60;

export const searchPlanSchema = z.object({
  origins: z
    .array(z.string())
    .min(1)
    .describe("Origin cities or airport codes as the user expressed them"),
  destinations: z
    .array(z.string())
    .describe("Destination cities/airports, or empty if a region is used"),
  destinationRegion: z
    .string()
    .optional()
    .describe("One of the six seats.aero regions, if the user named a region"),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  cabins: z
    .array(z.enum(["economy", "premium", "business", "first"]))
    .default(["economy", "premium", "business", "first"]),
  nonstopOnly: z.boolean().default(false),
  programs: z.array(z.string()).default([]),
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
): Promise<Partial<AgentStateType>> {
  const model = chat({ effort: "low", disableThinking: true }).withStructuredOutput(
    searchPlanSchema,
    { name: "search_plan" },
  );

  const now = new Date();
  const raw = await model.invoke([
    cachedSystem(PLAN_SEARCH_PROMPT),
    {
      role: "user",
      content: buildPlannerContext(lastUserText(state), now, conversationContext(state)),
    },
  ]);

  // Expand place names deterministically. The model names places; the lookup
  // table produces codes, so a hallucinated airport cannot reach the API.
  // Unresolved and ambiguous names are collected rather than silently
  // dropped — synthesize (Task 4.7) tells the user about them.
  const originsResult = expand(raw.origins);
  const destinationsResult = expand(raw.destinations);
  const unresolvedPlaces = [...originsResult.unresolved, ...destinationsResult.unresolved];
  const ambiguousPlaces = [...originsResult.ambiguous, ...destinationsResult.ambiguous];

  // Default dates when the model omits them, same as plan-discovery.ts —
  // otherwise an omitted date produces a search with no date bounds at all.
  const today = now.toISOString().slice(0, 10);
  const defaultEnd = new Date(now.getTime() + DEFAULT_WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const plan: SearchPlan = {
    origins: originsResult.codes,
    destinations: destinationsResult.codes,
    destinationRegion: raw.destinationRegion,
    startDate: raw.startDate ?? today,
    endDate: raw.endDate ?? defaultEnd,
    // withStructuredOutput's inferred RunOutput type treats zod .default()
    // fields as optional (it types against the schema's input, not its
    // output), even though the runtime value is always filled in by the
    // time it gets here. The fallbacks below just satisfy the type checker
    // with the same defaults searchPlanSchema already declares.
    cabins: raw.cabins ?? ["economy", "premium", "business", "first"],
    nonstopOnly: raw.nonstopOnly ?? false,
    programs: raw.programs ?? [],
    rationale: raw.rationale,
    unresolvedPlaces: unresolvedPlaces.length > 0 ? unresolvedPlaces : undefined,
    ambiguousPlaces: ambiguousPlaces.length > 0 ? ambiguousPlaces : undefined,
  };

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
    else if (r.kind === "region") r.representativeIatas.forEach((i) => codes.add(i));
    else if (r.kind === "ambiguous") ambiguous.push({ query: r.query, candidates: r.candidates });
    else unresolved.push(r.query); // kind === "unknown"
  }

  return { codes: [...codes], unresolved, ambiguous };
}

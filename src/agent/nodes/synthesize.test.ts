import { describe, it, expect } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import { buildNoFlightsDraft, buildSynthesisContext, sanitizeUserFacingAnalysis } from "./synthesize";
import { SYNTHESIZE_PROMPT } from "../prompts/synthesize";
import { estimateTokens, CACHE_MIN_TOKENS } from "../cache";
import type { AgentStateType } from "../state";

const state = (over: Partial<AgentStateType> = {}): AgentStateType =>
  ({
    messages: [new HumanMessage("options to Tokyo?")],
    intent: "route_search",
    // A real, resolved plan — so the default fixture represents a search
    // that actually ran, and an empty awardResults on it means "searched,
    // found nothing" rather than "never searched". Tests for the other two
    // cases (knowledge intent, unresolved plan) override this explicitly.
    searchPlan: {
      origins: ["ORD"],
      destinations: ["NRT"],
      cabins: [],
      nonstopOnly: false,
      programs: [],
    },
    awardResults: [
      {
        availabilityId: "a1",
        origin: "ORD",
        destination: "NRT",
        date: "2026-09-14",
        program: "aeroplan",
        cabin: "business",
        miles: 87500,
        taxes: 112.9,
        taxesCurrency: "USD",
        direct: true,
        airlines: "NH",
        updatedAt: "2026-08-11T09:00:00Z",
      },
    ],
    tripSummaries: [],
    kbDocs: [],
    violations: [],
    ...over,
  }) as AgentStateType;

describe("buildSynthesisContext", () => {
  it("includes the award options", () => {
    const ctx = buildSynthesisContext(state());
    expect(ctx).toContain("87500");
    expect(ctx).toContain("taxes=112.9");
    expect(ctx).toContain("taxesCurrency=USD");
    expect(ctx).not.toContain("a1");
  });

  it("names the selected card that transfers to the shown option's program", () => {
    const ctx = buildSynthesisContext(
      state({ tripRequest: { creditCardPrograms: ["chase"] } as never }),
    );
    expect(ctx).toContain("Air Canada Aeroplan");
    expect(ctx).toContain("Chase");
  });

  it("omits a selected card that does not transfer to the shown option's program", () => {
    // Citi does not transfer to Aeroplan.
    const ctx = buildSynthesisContext(
      state({ tripRequest: { creditCardPrograms: ["citi"] } as never }),
    );
    expect(ctx).not.toContain("Citi");
    expect(ctx).not.toContain("transfer partner");
  });

  it("omits transfer-partner context entirely for a chat turn with no card selection", () => {
    const ctx = buildSynthesisContext(state());
    expect(ctx).not.toContain("transfer partner");
  });

  it("supplies only the five highest-ranked options and labels the full count", () => {
    const options = Array.from({ length: 7 }, (_, i) => ({
      ...state().awardResults[0],
      availabilityId: `a${i + 1}`,
    }));
    const ctx = buildSynthesisContext(state({ awardResults: options }));
    expect(ctx).toContain("5 of 7 returned");
    expect(ctx).toContain("5. ORD-NRT");
    expect(ctx).not.toContain("a6");
  });

  it("includes the user question", () => {
    expect(buildSynthesisContext(state())).toContain("options to Tokyo?");
  });

  it("keeps knowledge document identifiers out of the writer context, but not sources", () => {
    const s = state({
      kbDocs: [
        {
          id: "ana-777",
          collection: "products",
          text: "The Room is excellent.",
          sources: ["https://x"],
          updated: "2026-06-01",
        },
      ],
    });
    const ctx = buildSynthesisContext(s);
    expect(ctx).toContain("The Room is excellent.");
    expect(ctx).not.toContain("ana-777");
  });

  it("[REGRESSION] includes a research note's source URLs so the model can cite them — frontmatter.ts documents this as the intended design", () => {
    const s = state({
      kbDocs: [
        {
          id: "ana-777",
          collection: "products",
          text: "The Room is excellent.",
          sources: ["https://www.ana.co.jp/the-room"],
          updated: "2026-06-01",
        },
      ],
    });
    const ctx = buildSynthesisContext(s);
    expect(ctx).toContain("https://www.ana.co.jp/the-room");
  });

  it("omits a Sources line for a research note with no sources", () => {
    const s = state({
      kbDocs: [{ id: "x", collection: "booking", text: "A booking note.", sources: [], updated: "2026-06-01" }],
    });
    const ctx = buildSynthesisContext(s);
    expect(ctx).not.toMatch(/Sources:/);
  });

  it("suppresses knowledge excerpts when a flight search found no options", () => {
    const ctx = buildSynthesisContext(
      state({
        awardResults: [],
        kbDocs: [
          {
            id: "generic-trivia",
            collection: "seasonality",
            text: "A long generic knowledge dump.",
            sources: [],
            updated: "2026-06-01",
          },
        ],
      }),
    );

    expect(ctx).not.toContain("generic-trivia");
    expect(ctx).not.toContain("generic knowledge dump");
  });

  it("says plainly when no options were found rather than leaving a blank", () => {
    expect(buildSynthesisContext(state({ awardResults: [] }))).toMatch(
      /no award availability/i,
    );
  });

  it("does not claim 'no availability' for a knowledge question that never searched", () => {
    const ctx = buildSynthesisContext(
      state({ intent: "knowledge", searchPlan: null, awardResults: [] }),
    );
    expect(ctx).not.toMatch(/no award availability/i);
    expect(ctx).toMatch(/no availability search was performed/i);
  });

  it("does not claim 'no availability' when the plan never had a usable origin/destination", () => {
    const ctx = buildSynthesisContext(
      state({
        intent: "route_search",
        searchPlan: {
          origins: ["ORD"],
          destinations: [],
          cabins: [],
          nonstopOnly: false,
          programs: [],
        } as never,
        awardResults: [],
      }),
    );
    expect(ctx).not.toMatch(/no award availability/i);
    expect(ctx).toMatch(/no search was run/i);
  });

  it("does not claim 'no availability' for a discovery search whose plan has zero probes", () => {
    const ctx = buildSynthesisContext(
      state({
        intent: "discovery",
        searchPlan: {
          origins: ["ORD"],
          destinations: [],
          cabins: [],
          nonstopOnly: false,
          programs: [],
          discoveryProbes: [],
        } as never,
        awardResults: [],
      }),
    );
    expect(ctx).not.toMatch(/no award availability/i);
    expect(ctx).toMatch(/no search was run/i);
  });

  it("passes violations back on a retry so the model knows what to fix", () => {
    const s = state({
      violations: [{ kind: "unsupported_number", detail: "92,000 not in results" }],
    });
    const ctx = buildSynthesisContext(s);
    expect(ctx).toContain("92,000");
    expect(ctx).toMatch(/correct/i);
  });

  it("includes data freshness so the answer can label it", () => {
    expect(buildSynthesisContext(state())).toContain("2026-08-11T09:00:00Z");
  });

  it("labels trip details with their visible option number instead of an availability id", () => {
    const s = state({
      tripSummaries: [
        {
          availabilityId: "a1",
          tripId: "t1",
          flightNumbers: ["MS948", "MS964"],
          aircraft: ["777-300ER"],
          carriers: ["MS"],
          stops: 1,
          cabin: "business",
          miles: 87500,
          totalTaxes: 73.4,
          taxesCurrency: "USD",
        },
      ],
    });
    const ctx = buildSynthesisContext(s);
    expect(ctx).toContain("for option 1");
    expect(ctx).not.toContain("a1");
    expect(ctx).toContain("cabin=business");
    expect(ctx).toContain("miles=87500");
    expect(ctx).toContain("taxes=73.4");
    expect(ctx).toContain("taxesCurrency=USD");
  });

  it("includes connection and duration details that can add value beyond the card summary", () => {
    const s = state({
      tripSummaries: [
        {
          availabilityId: "a1",
          tripId: "t1",
          flightNumbers: ["DL1717", "DL121"],
          aircraft: ["Airbus A220", "Airbus A350-900"],
          carriers: ["DL"],
          stops: 1,
          durationMinutes: 1005,
          connections: [{ airport: "MSP", layoverMinutes: 141 }],
          totalTaxes: 38,
          taxesCurrency: "USD",
        },
      ],
    });
    const ctx = buildSynthesisContext(s);
    expect(ctx).toContain("connections=MSP(141m)");
    expect(ctx).toContain("durationMinutes=1005");
    expect(ctx).toContain("taxes=38");
    expect(ctx).toContain("taxesCurrency=USD");
  });

  it("surfaces an unresolved place name rather than silently searching without it", () => {
    const s = state({
      searchPlan: {
        origins: ["ORD"],
        destinations: [],
        cabins: [],
        nonstopOnly: false,
        programs: [],
        unresolvedPlaces: ["Wakanda"],
      } as never,
    });
    expect(buildSynthesisContext(s)).toContain("Wakanda");
  });

  it("[BUG-STALE-DIAGNOSTIC-LEAK] does not surface a stale unresolvedPlaces from an earlier search turn on an unrelated knowledge-intent turn", () => {
    const s = state({
      intent: "knowledge",
      searchPlan: {
        origins: ["ORD"],
        destinations: [],
        cabins: [],
        nonstopOnly: false,
        programs: [],
        unresolvedPlaces: ["Nowhereville"],
      } as never,
    });
    const ctx = buildSynthesisContext(s);
    expect(ctx).not.toContain("Nowhereville");
    expect(ctx).not.toMatch(/location resolution notes/i);
  });

  it("surfaces an ambiguous place's candidates so the model can ask which was meant", () => {
    const s = state({
      searchPlan: {
        origins: ["ORD"],
        destinations: [],
        cabins: [],
        nonstopOnly: false,
        programs: [],
        ambiguousPlaces: [{ query: "San", candidates: ["San Francisco", "San Diego"] }],
      } as never,
    });
    const ctx = buildSynthesisContext(s);
    expect(ctx).toContain("San Francisco");
    expect(ctx).toContain("San Diego");
  });

  it("strips availability, trip, and knowledge identifiers from user-facing analysis", () => {
    const s = state({
      tripSummaries: [{ availabilityId: "a1", tripId: "trip-private", flightNumbers: [], aircraft: [], carriers: [], stops: 0 }],
      kbDocs: [{ id: "ana-777", collection: "products", text: "Internal note", sources: [], updated: "2026-06-01" }],
    });
    const draft = "Use option a1 [ana-777]; trip-private is internal.";
    expect(sanitizeUserFacingAnalysis(draft, s)).toBe("Use option ; is internal.");
  });
});

describe("buildNoFlightsDraft", () => {
  it("briefly asks for changes after an exhausted USA to EUR search", () => {
    const draft = buildNoFlightsDraft(
      state({
        awardResults: [],
        searchStatus: "searched",
        searchAttempts: [
          { tier: "exact", origins: ["USA"], destinations: ["EUR"], reason: "Exact requested route.", resultCount: 0 },
          { tier: "country_pair", origins: ["USA"], destinations: ["EUR"], reason: "Broadened.", resultCount: 0 },
        ],
        searchPlan: {
          origins: ["USA"],
          destinations: ["EUR"],
          destinationRegion: "Europe",
          startDate: "2026-09-16",
          endDate: "2026-09-18",
          cabins: ["business", "first"],
          nonstopOnly: false,
          programs: ["aeroplan"],
        },
      }),
    );

    expect(draft).toContain("United States — large airports");
    expect(draft).toContain("Europe — large airports");
    expect(draft).toMatch(/widen the dates/i);
    expect(draft.split("\n")).toHaveLength(1);
    expect(draft.length).toBeLessThan(500);
  });

  it("does not call an outage 'no availability'", () => {
    const draft = buildNoFlightsDraft(
      state({
        awardResults: [],
        searchStatus: "provider_error",
      }),
    );
    expect(draft).toMatch(/did not return a usable response/i);
    expect(draft).toMatch(/retry/i);
  });
});

describe("SYNTHESIZE_PROMPT", () => {
  it("is long enough to cache", () => {
    expect(estimateTokens(SYNTHESIZE_PROMPT)).toBeGreaterThanOrEqual(
      CACHE_MIN_TOKENS,
    );
  });

  it("contains no volatile value", () => {
    expect(SYNTHESIZE_PROMPT).not.toMatch(/20\d\d-\d\d-\d\d/);
  });

  it("treats analysis as decision support instead of a duplicate flight list", () => {
    expect(SYNTHESIZE_PROMPT).toContain("not to transcribe it");
    expect(SYNTHESIZE_PROMPT).toContain("**Bottom line:**");
    expect(SYNTHESIZE_PROMPT).toContain("**What matters:**");
    expect(SYNTHESIZE_PROMPT).toContain("**Next step:**");
    expect(SYNTHESIZE_PROMPT).toContain("never exceed 220 words");
    expect(SYNTHESIZE_PROMPT).toMatch(/Do not enumerate all\s+alternatives/);
  });

  it("keeps internal research and provider identifiers out of user-facing analysis", () => {
    expect(SYNTHESIZE_PROMPT).toMatch(/never say "knowledge base"/i);
    expect(SYNTHESIZE_PROMPT).toMatch(/Availability IDs,[\s\S]*never user-facing/i);
    expect(SYNTHESIZE_PROMPT).not.toMatch(/cite that excerpt's id/i);
  });

  it("[REGRESSION] permits citing a research excerpt's source URL, resolving the prompt/frontmatter design disagreement", () => {
    expect(SYNTHESIZE_PROMPT).toMatch(/cite a source url|source url in prose/i);
  });
});

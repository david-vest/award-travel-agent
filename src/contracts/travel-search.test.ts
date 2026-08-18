import { describe, expect, it } from "vitest";
import { agentRunRequestSchema, tripRequestSchema } from "./travel-search";

const validRequest = {
  origin: { code: "SFO", airports: ["SFO"], custom: false },
  destinations: [{ code: "TYO", airports: ["HND", "NRT"], custom: false }],
  startDate: "2026-09-18",
  endDate: "2026-09-27",
  flexDays: 2,
  cabins: ["business"],
  travelers: 2,
  stopPreference: "nonstop",
  preferredAirlines: ["NH"],
  creditCardPrograms: ["chase"],
  awardPrograms: ["united"],
  pointBalances: { creditCards: {}, awardPrograms: {} },
};

describe("agentRunRequestSchema", () => {
  it("accepts a request-only body", () => {
    expect(agentRunRequestSchema.safeParse({ request: validRequest }).success).toBe(true);
  });

  it("accepts a message-only body", () => {
    expect(agentRunRequestSchema.safeParse({ message: "any business flight to Tokyo" }).success).toBe(true);
  });

  it("[REGRESSION] rejects a body carrying both a structured request and a message", () => {
    const result = agentRunRequestSchema.safeParse({ request: validRequest, message: "ignore the form above" });
    expect(result.success).toBe(false);
  });

  it("rejects a body with neither request nor message", () => {
    expect(agentRunRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("tripRequestSchema date validation", () => {
  it("[REGRESSION] rejects a calendar-invalid date that still matches the YYYY-MM-DD regex", () => {
    const result = tripRequestSchema.safeParse({ ...validRequest, startDate: "2026-02-30" });
    expect(result.success).toBe(false);
  });

  it("[REGRESSION] rejects endDate before startDate", () => {
    const result = tripRequestSchema.safeParse({ ...validRequest, startDate: "2026-09-27", endDate: "2026-09-18" });
    expect(result.success).toBe(false);
  });

  it("accepts endDate equal to startDate (a single-day search)", () => {
    const result = tripRequestSchema.safeParse({ ...validRequest, startDate: "2026-09-18", endDate: "2026-09-18" });
    expect(result.success).toBe(true);
  });
});

describe("tripRequestSchema bounded and validated identifiers", () => {
  it("[REGRESSION] rejects an award program id that isn't a known program", () => {
    const result = tripRequestSchema.safeParse({ ...validRequest, awardPrograms: ["not_a_real_program"] });
    expect(result.success).toBe(false);
  });

  it("[REGRESSION] rejects a credit card program id that isn't a known card", () => {
    const result = tripRequestSchema.safeParse({ ...validRequest, creditCardPrograms: ["not_a_real_card"] });
    expect(result.success).toBe(false);
  });

  it("rejects an unbounded destinations array", () => {
    const manyDestinations = Array.from({ length: 21 }, () => validRequest.destinations[0]);
    const result = tripRequestSchema.safeParse({ ...validRequest, destinations: manyDestinations });
    expect(result.success).toBe(false);
  });

  it("rejects an unbounded awardPrograms array", () => {
    const result = tripRequestSchema.safeParse({
      ...validRequest,
      awardPrograms: Array.from({ length: 30 }, () => "united"),
    });
    expect(result.success).toBe(false);
  });
});

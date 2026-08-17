import { describe, it, expect } from "vitest";
import { blendedCost, POINTS_VALUE_CPP } from "./points-value";

describe("blendedCost", () => {
  it("returns miles unchanged when there are no fees", () => {
    expect(blendedCost(55_000)).toBe(55_000);
    expect(blendedCost(55_000, undefined, "USD")).toBe(55_000);
  });

  it("adds a USD fee at the blended points-value rate", () => {
    // $50 at 1.5 cents/point = 50 * 100 / 1.5 = 3333.33... points-equivalent.
    expect(blendedCost(55_000, 50, "USD")).toBeCloseTo(58_333.33, 1);
  });

  it("ranks a cheaper-fee, higher-miles option below an expensive-fee, lower-miles option", () => {
    // The motivating case: 55k Alaska miles + $50 (MIA-CDG) should beat
    // 45k BA Avios + $1000 (JFK-CDG) once fees are weighed in.
    const alaska = blendedCost(55_000, 50, "USD");
    const ba = blendedCost(45_000, 1_000, "USD");
    expect(alaska).toBeLessThan(ba);
  });

  it("defaults an unspecified currency to USD", () => {
    expect(blendedCost(10_000, 100)).toBe(blendedCost(10_000, 100, "USD"));
  });

  it("converts a known non-USD currency at its approximate rate", () => {
    // CAD fees should cost less points-equivalent than the same nominal
    // amount in USD, since 1 CAD is worth less than 1 USD.
    const usd = blendedCost(10_000, 100, "USD");
    const cad = blendedCost(10_000, 100, "CAD");
    expect(cad).toBeLessThan(usd);
    expect(cad).toBeGreaterThan(10_000);
  });

  it("does not score a fee in an unrecognized currency, since guessing a rate would be worse than not scoring it", () => {
    expect(blendedCost(10_000, 100, "XYZ")).toBe(10_000);
  });

  it("treats a zero or negative fee as no fee", () => {
    expect(blendedCost(10_000, 0, "USD")).toBe(10_000);
    expect(blendedCost(10_000, -5, "USD")).toBe(10_000);
  });

  it("exposes the blended rate as a named constant", () => {
    expect(POINTS_VALUE_CPP).toBe(1.5);
  });
});

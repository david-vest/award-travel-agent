import { describe, it, expect } from "vitest";
import { normalizeResults } from "./search-awards";
import type { AvailabilityResult } from "./seats-aero/types";

const record: AvailabilityResult = {
  ID: "abc123",
  RouteID: "r1",
  Route: {
    ID: "r1",
    OriginAirport: "ORD",
    DestinationAirport: "NRT",
    Distance: 6280,
    Source: "aeroplan",
  },
  Date: "2026-09-14",
  ParsedDate: "2026-09-14",
  Source: "aeroplan",
  YAvailable: true,
  WAvailable: false,
  JAvailable: true,
  FAvailable: false,
  YMileageCost: "45000",
  WMileageCost: "0",
  JMileageCost: "87500",
  FMileageCost: "0",
  YDirect: false,
  WDirect: false,
  JDirect: true,
  FDirect: false,
  JRemainingSeats: 2,
  Airlines: "NH, AC",
  JAirlines: "NH",
  TaxesCurrency: "USD",
  JTotalTaxes: 11290,
  UpdatedAt: "2026-08-11T09:00:00Z",
};

describe("normalizeResults", () => {
  it("emits one option per available cabin", () => {
    const options = normalizeResults([record]);
    expect(options.map((o) => o.cabin).sort()).toEqual(["business", "economy"]);
  });

  it("omits cabins that are not available", () => {
    const options = normalizeResults([record]);
    expect(options.some((o) => o.cabin === "first")).toBe(false);
  });

  it("parses mileage cost as a number", () => {
    const j = normalizeResults([record]).find((o) => o.cabin === "business");
    expect(j?.miles).toBe(87500);
  });

  it("carries per-cabin direct and airline fields, not the record-level ones", () => {
    const j = normalizeResults([record]).find((o) => o.cabin === "business");
    expect(j?.direct).toBe(true);
    expect(j?.airlines).toBe("NH");
  });

  it("normalizes the cabin tax total from provider minor units", () => {
    const j = normalizeResults([record]).find((o) => o.cabin === "business");
    expect(j?.taxes).toBe(112.9);
    expect(j?.taxesCurrency).toBe("USD");
  });

  it("does not present a missing-tax zero sentinel as free", () => {
    const missingTaxes = { ...record, JTotalTaxes: 0 };
    const j = normalizeResults([missingTaxes]).find(
      (o) => o.cabin === "business",
    );
    expect(j?.taxes).toBeUndefined();
  });

  it("preserves the availability id so refresh and trips can find it", () => {
    const j = normalizeResults([record]).find((o) => o.cabin === "business");
    expect(j?.availabilityId).toBe("abc123");
  });

  it("drops records with a zero mileage cost as bad data", () => {
    const bad = { ...record, JMileageCost: "0" };
    const options = normalizeResults([bad]);
    expect(options.some((o) => o.cabin === "business")).toBe(false);
  });

  it("drops records with a negative mileage cost as bad data", () => {
    const bad = { ...record, JMileageCost: "-500" };
    const options = normalizeResults([bad]);
    expect(options.some((o) => o.cabin === "business")).toBe(false);
  });

  it("drops records with a non-numeric mileage cost as bad data", () => {
    const bad = { ...record, JMileageCost: "abc" };
    const options = normalizeResults([bad]);
    expect(options.some((o) => o.cabin === "business")).toBe(false);
  });

  it("carries a genuine positive remaining-seats count through", () => {
    const j = normalizeResults([record]).find((o) => o.cabin === "business");
    expect(j?.remainingSeats).toBe(2);
  });

  it("treats a zero remaining-seats count as unknown, not sold out", () => {
    // seats.aero reports 0 for many programs it just doesn't track a real
    // count for; the record only exists because JAvailable was true, so at
    // least one seat is implied. A literal 0 here would read downstream as
    // "not bookable," which is wrong.
    const zeroSeats = { ...record, JRemainingSeats: 0 };
    const j = normalizeResults([zeroSeats]).find((o) => o.cabin === "business");
    expect(j?.remainingSeats).toBeUndefined();
  });

  it("treats a missing remaining-seats field as unknown", () => {
    const noSeats = { ...record, JRemainingSeats: undefined };
    const j = normalizeResults([noSeats]).find((o) => o.cabin === "business");
    expect(j?.remainingSeats).toBeUndefined();
  });

  it("normalizes a timestamp-shaped ParsedDate to YYYY-MM-DD", () => {
    const timestamped = { ...record, ParsedDate: "2026-09-14T00:00:00Z" };
    const options = normalizeResults([timestamped]);
    expect(options.every((o) => o.date === "2026-09-14")).toBe(true);
  });
});

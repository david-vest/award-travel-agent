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

  it("normalizes a timestamp-shaped ParsedDate to YYYY-MM-DD", () => {
    const timestamped = { ...record, ParsedDate: "2026-09-14T00:00:00Z" };
    const options = normalizeResults([timestamped]);
    expect(options.every((o) => o.date === "2026-09-14")).toBe(true);
  });
});

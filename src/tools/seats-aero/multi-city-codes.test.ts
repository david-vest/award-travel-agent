import { describe, expect, it } from "vitest";
import {
  SEATS_AERO_SEARCH_CODES,
  countryGroup,
  primaryGatewayMetro,
  regionGroup,
  resolveSeatsAeroSearchCode,
  searchCodeDefinition,
  searchCodeForRegion,
  searchCodesMentioned,
} from "./multi-city-codes";

describe("seats.aero multi-city codes", () => {
  it("contains the complete published catalog", () => {
    expect(SEATS_AERO_SEARCH_CODES).toHaveLength(39);
    expect(SEATS_AERO_SEARCH_CODES.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "AAH",
        "ANZ",
        "ASA",
        "CAL",
        "EUR",
        "LON",
        "NYC",
        "SAM",
        "TYO",
        "USA",
        "WAS",
      ]),
    );
  });

  it("keeps provider airport membership with every canonical code", () => {
    for (const entry of SEATS_AERO_SEARCH_CODES) {
      expect(entry.airports.length).toBeGreaterThan(0);
      expect(entry.airports.every((airport) => /^[A-Z]{3}$/.test(airport))).toBe(true);
    }
    expect(searchCodeDefinition("ASA")?.airports).toEqual(
      expect.arrayContaining(["HND", "NRT", "ICN", "TPE", "BKK"]),
    );
  });

  it.each([
    ["United States", "USA"],
    ["Europe", "EUR"],
    ["California", "CAL"],
    ["Schengen Area", "SCH"],
    ["Tokyo", "TYO"],
    ["Australia & New Zealand", "ANZ"],
    ["São Paulo", "SAO"],
  ])("resolves the published name %s to %s", (name, code) => {
    expect(resolveSeatsAeroSearchCode(name)?.code).toBe(code);
  });

  it("keeps several explicitly named groups in textual order", () => {
    expect(searchCodesMentioned("California, NYC, or Washington DC")).toEqual([
      "CAL",
      "NYC",
      "WAS",
    ]);
  });

  it("prefers a specific group over an overlapping broad name", () => {
    expect(searchCodesMentioned("Southeast Asia")).toEqual(["SEA"]);
    expect(searchCodesMentioned("US East Coast")).toEqual(["EST"]);
  });

  it("does not interpret the ordinary pronoun us as the USA code", () => {
    expect(searchCodesMentioned("show us business flights to Europe")).toEqual([
      "EUR",
    ]);
  });

  it("maps only regions with an equivalent published grouping", () => {
    expect(searchCodeForRegion("Europe")).toBe("EUR");
    expect(searchCodeForRegion("Asia")).toBe("ASA");
    expect(searchCodeForRegion("South America")).toBe("SAM");
    expect(searchCodeForRegion("North America")).toBeUndefined();
    expect(searchCodeForRegion("Africa")).toBeUndefined();
  });

  it("uses only published country codes for positioning", () => {
    expect(countryGroup("Germany")?.code).toBe("GCR");
    expect(countryGroup("Mexico")?.code).toBe("MEX");
    expect(countryGroup("India")).toBeUndefined();
    expect(primaryGatewayMetro(countryGroup("Japan"))?.code).toBe("TYO");
  });

  it("does not revive unsupported codes from the removed legacy catalog", () => {
    for (const code of ["GER", "MXC", "QAF", "SAS", "INDIA"]) {
      expect(searchCodeDefinition(code)).toBeUndefined();
    }
    expect(regionGroup("Africa")).toBeUndefined();
    expect(regionGroup("Asia")?.code).toBe("ASA");
  });
});

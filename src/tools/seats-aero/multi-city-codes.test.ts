import { describe, expect, it } from "vitest";
import {
  SEATS_AERO_SEARCH_CODES,
  resolveSeatsAeroSearchCode,
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
});

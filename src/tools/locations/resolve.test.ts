import { describe, it, expect } from "vitest";
import { resolveLocation } from "./resolve";

describe("resolveLocation", () => {
  it("recognizes seats.aero's USA and EUR multi-city codes", () => {
    expect(resolveLocation("USA")).toMatchObject({
      kind: "airports",
      iatas: ["USA"],
    });
    expect(resolveLocation("EUR")).toMatchObject({
      kind: "airports",
      iatas: ["EUR"],
    });
  });

  it("maps United States wording to seats.aero's USA multi-city code", () => {
    expect(resolveLocation("United States")).toMatchObject({
      kind: "airports",
      iatas: ["USA"],
    });
  });

  it("uses a published metropolitan code when seats.aero has one", () => {
    const r = resolveLocation("Chicago");
    expect(r.kind).toBe("airports");
    if (r.kind !== "airports") return;
    expect(r.iatas).toEqual(["CHI"]);
  });

  it("is case and whitespace insensitive", () => {
    const a = resolveLocation("  chicago ");
    const b = resolveLocation("CHICAGO");
    expect(a).toEqual(b);
  });

  it("passes a bare IATA code straight through", () => {
    const r = resolveLocation("NRT");
    expect(r).toMatchObject({ kind: "airports", iatas: ["NRT"] });
  });

  it("resolves airports the old curated table did not cover", () => {
    const austin = resolveLocation("AUS");
    expect(austin).toMatchObject({ kind: "airports", iatas: ["AUS"] });
    const prague = resolveLocation("Prague");
    expect(prague.kind).toBe("airports");
    if (prague.kind !== "airports") return;
    expect(prague.iatas).toContain("PRG");
  });

  it("uses a published large-airport code instead of a hand-picked region sample", () => {
    const r = resolveLocation("Asia");
    expect(r).toMatchObject({ kind: "airports", iatas: ["ASA"] });
  });

  it("resolves Europe to seats.aero's published EUR grouping", () => {
    const r = resolveLocation("Europe");
    expect(r).toMatchObject({ kind: "airports", iatas: ["EUR"] });
  });

  it("resolves an unambiguous partial city match", () => {
    const r = resolveLocation("Reykjav"); // Reykjavik — one city, no exact-match hit
    expect(r.kind).toBe("airports");
    if (r.kind !== "airports") return;
    expect(r.iatas).toContain("RKV");
  });

  it("returns ambiguous, not a guess, when a partial match spans multiple cities", () => {
    // "Santa" (not "San") deliberately avoids the 3-letter bare-IATA branch —
    // "San" happens to also be SAN, San Diego's real code, which would resolve
    // directly there and never reach this fallback tier at all.
    const r = resolveLocation("Santa"); // Santa Ana, Santa Barbara, Santa Cruz, ...
    expect(r.kind).toBe("ambiguous");
    if (r.kind !== "ambiguous") return;
    expect(r.candidates.length).toBeGreaterThan(1);
  });

  it("still resolves a lowercase-typed IATA code (SAN is a real airport, not just a city prefix)", () => {
    const r = resolveLocation("san");
    expect(r).toMatchObject({ kind: "airports", iatas: ["SAN"] });
  });

  it("returns unknown rather than guessing", () => {
    const r = resolveLocation("Wakanda");
    expect(r).toEqual({ kind: "unknown", query: "Wakanda" });
  });

  it("never invents an IATA code for an unknown place", () => {
    const r = resolveLocation("zzzzz");
    expect(r.kind).toBe("unknown");
  });

  it("uses the published London metropolitan grouping rather than an ambiguous city match", () => {
    const r = resolveLocation("London");
    expect(r).toMatchObject({ kind: "airports", iatas: ["LON"] });
  });

  it("uses the published Chicago grouping for an exact city name", () => {
    const r = resolveLocation("Chicago");
    expect(r.kind).toBe("airports");
    if (r.kind !== "airports") return;
    expect(r.iatas).toEqual(["CHI"]);
  });

  it("keeps a broad area without a published grouping as a region", () => {
    expect(resolveLocation("Africa")).toMatchObject({
      kind: "region",
      region: "Africa",
    });
  });

  it("returns unknown for an empty or whitespace-only query without doing any lookup", () => {
    expect(resolveLocation("")).toEqual({ kind: "unknown", query: "" });
    expect(resolveLocation("   ")).toEqual({ kind: "unknown", query: "" });
  });

  it("caps the ambiguous candidates list and notes the truncation", () => {
    const r = resolveLocation("port");
    expect(r.kind).toBe("ambiguous");
    if (r.kind !== "ambiguous") return;
    expect(r.candidates.length).toBeLessThanOrEqual(11); // 10 real + 1 synthetic "...and N more"
    expect(r.candidates[r.candidates.length - 1]).toMatch(/^\.\.\. and \d+ more$/);
  });

  it("does not resolve 'constructor' via the Object prototype chain", () => {
    const r = resolveLocation("constructor");
    expect(r.kind).toBe("unknown");
  });
});

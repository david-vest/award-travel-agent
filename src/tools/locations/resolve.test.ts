import { describe, it, expect } from "vitest";
import { resolveLocation } from "./resolve";

describe("resolveLocation", () => {
  it("expands a city to all its airports", () => {
    const r = resolveLocation("Chicago");
    expect(r.kind).toBe("airports");
    if (r.kind !== "airports") return;
    expect(r.iatas).toEqual(expect.arrayContaining(["ORD", "MDW"]));
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

  it("resolves a continent to a region plus representative MAJOR_HUBS airports", () => {
    const r = resolveLocation("Asia");
    expect(r.kind).toBe("region");
    if (r.kind !== "region") return;
    expect(r.region).toBe("Asia");
    expect(r.representativeIatas.length).toBeGreaterThan(3);
    // must be real hubs, not whatever the full ~6,000-row table happens to sort first
    expect(r.representativeIatas).toEqual(
      expect.arrayContaining([expect.stringMatching(/^(NRT|HND|SIN|ICN|HKG)$/)]),
    );
  });

  it("resolves a known region synonym", () => {
    const r = resolveLocation("Europe");
    expect(r).toMatchObject({ kind: "region", region: "Europe" });
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

  it("returns ambiguous, not a merged guess, when an exact city name spans multiple countries", () => {
    const r = resolveLocation("London");
    expect(r.kind).toBe("ambiguous");
    if (r.kind !== "ambiguous") return;
    expect(r.candidates).toEqual(
      expect.arrayContaining([expect.stringContaining("United Kingdom")]),
    );
    expect(r.candidates).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/United States|Canada/),
      ]),
    );
  });

  it("still resolves an exact city match normally when it's confined to one country", () => {
    const r = resolveLocation("Chicago");
    expect(r.kind).toBe("airports");
    if (r.kind !== "airports") return;
    expect(r.iatas).toEqual(expect.arrayContaining(["ORD", "MDW"]));
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

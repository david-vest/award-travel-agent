import { describe, it, expect } from "vitest";
import { parseKbFile, frontmatterSchema } from "./frontmatter";

const valid = `---
id: turkish-europe-business
collection: sweet-spots
programs: [turkish]
airlines: [TK]
cabin: business
updated: 2026-06-01
sources: ["https://example.com/turkish"]
---

Turkish Miles&Smiles charges 45,000 miles one-way for business class to Europe.
`;

describe("parseKbFile", () => {
  it("parses valid frontmatter and body", () => {
    const { frontmatter, body } = parseKbFile(valid, "x.md");
    expect(frontmatter.id).toBe("turkish-europe-business");
    expect(frontmatter.collection).toBe("sweet-spots");
    expect(body).toContain("45,000 miles");
  });

  it("normalizes updated to an ISO date string", () => {
    const { frontmatter } = parseKbFile(valid, "x.md");
    expect(frontmatter.updated).toBe("2026-06-01");
  });

  it("defaults optional arrays to empty rather than undefined", () => {
    const minimal = `---
id: x
collection: booking
updated: 2026-06-01
---
Body.`;
    const { frontmatter } = parseKbFile(minimal, "x.md");
    expect(frontmatter.airlines).toEqual([]);
    expect(frontmatter.programs).toEqual([]);
  });

  it("rejects an unknown collection", () => {
    const bad = valid.replace("collection: sweet-spots", "collection: rumors");
    expect(() => parseKbFile(bad, "bad.md")).toThrow(/collection/);
  });

  it("rejects a document with an empty body", () => {
    const empty = `---
id: x
collection: booking
updated: 2026-06-01
---
`;
    expect(() => parseKbFile(empty, "empty.md")).toThrow(/body/i);
  });

  it("names the offending file in the error", () => {
    const bad = valid.replace("id: turkish-europe-business", "");
    expect(() => parseKbFile(bad, "oops.md")).toThrow(/oops\.md/);
  });
});

describe("frontmatterSchema", () => {
  it("requires a sources array on product reviews", () => {
    expect(() =>
      frontmatterSchema.parse({
        id: "x",
        collection: "products",
        updated: "2026-06-01",
      }),
    ).toThrow();
  });

  it("requires sources for any document allowed to affect scoring", () => {
    expect(() => frontmatterSchema.parse({
      id: "airport-note",
      collection: "airports",
      updated: "2026-06-01",
      airports: ["LAX"],
      dimensions: ["connection_quality"],
    })).toThrow(/scoring/i);
  });

  it("allows a program id that isn't seats.aero-searchable (e.g. a card transfer partner our search tool can't query)", () => {
    // knowledge/transfers/*.md legitimately lists every real transfer
    // partner a card has, including airlines seats.aero doesn't track
    // (British Airways, Iberia, ANA, ...) — restricting `programs` to
    // MILEAGE_PROGRAMS would delete accurate content, so this stays
    // free-form. What actually matters is that identifiers matching a
    // *searchable* program are spelled consistently — see
    // knowledge-programs-consistency.test.ts.
    expect(() =>
      frontmatterSchema.parse({
        id: "x",
        collection: "transfers",
        updated: "2026-06-01",
        programs: ["britishairways", "aeroplan"],
      }),
    ).not.toThrow();
  });
});

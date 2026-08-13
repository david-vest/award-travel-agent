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
});

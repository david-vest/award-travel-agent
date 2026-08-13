import { describe, it, expect } from "vitest";
import { toDocument } from "./store";

describe("toDocument", () => {
  const fm = {
    id: "ana-777",
    collection: "products" as const,
    updated: "2026-06-01",
    airlines: ["NH"],
    aircraft: ["777-300ER"],
    programs: ["united", "aeroplan"],
    regions: [],
    cabin: "business" as const,
    sources: ["https://example.com"],
  };

  it("uses the body as page content", () => {
    const d = toDocument(fm, "The Room is excellent.", "products/ana.md");
    expect(d.pageContent).toContain("The Room");
  });

  it("copies filterable fields into metadata", () => {
    const d = toDocument(fm, "body", "products/ana.md");
    expect(d.metadata.airlines).toEqual(["NH"]);
    expect(d.metadata.programs).toEqual(["united", "aeroplan"]);
    expect(d.metadata.collection).toBe("products");
  });

  it("uppercases airline codes so filtering is case-insensitive at query time", () => {
    const d = toDocument({ ...fm, airlines: ["nh"] }, "body", "x.md");
    expect(d.metadata.airlines).toEqual(["NH"]);
  });

  it("carries sources and updated for citation rendering", () => {
    const d = toDocument(fm, "body", "products/ana.md");
    expect(d.metadata.sources).toEqual(["https://example.com"]);
    expect(d.metadata.updated).toBe("2026-06-01");
  });

  it("records the source path for debugging a bad retrieval", () => {
    const d = toDocument(fm, "body", "products/ana.md");
    expect(d.metadata.path).toBe("products/ana.md");
  });
});

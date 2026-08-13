import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseKbFile, COLLECTIONS } from "./frontmatter";

const ROOT = path.resolve(process.cwd(), "knowledge");

describe("knowledge base", () => {
  it("parses every markdown file", async () => {
    const seen: string[] = [];
    for (const collection of COLLECTIONS) {
      const dir = path.join(ROOT, collection);
      const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
      for (const f of files) {
        const raw = await readFile(path.join(dir, f), "utf8");
        const { frontmatter } = parseKbFile(raw, `${collection}/${f}`);
        expect(frontmatter.collection).toBe(collection);
        seen.push(frontmatter.id);
      }
    }
    expect(seen.length).toBeGreaterThanOrEqual(30);
  });

  it("has no duplicate ids", async () => {
    const ids: string[] = [];
    for (const collection of COLLECTIONS) {
      const dir = path.join(ROOT, collection);
      for (const f of (await readdir(dir)).filter((f) => f.endsWith(".md"))) {
        const raw = await readFile(path.join(dir, f), "utf8");
        ids.push(parseKbFile(raw, f).frontmatter.id);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});

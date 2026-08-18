// Scans every real knowledge/**/*.md file for program identifiers that are a
// known misspelling of a real seats.aero-searchable program id. `programs`
// frontmatter is intentionally free-form (see frontmatter.test.ts) — most
// non-MILEAGE_PROGRAMS entries are legitimate transfer partners our search
// tool can't query, not drift. But a doc using "qatarairways" instead of
// "qatar" (etc.) silently never matches buildPreFilter's OR clause for a
// real Qatar search result, which IS a bug — this guards against exactly
// that class of drift without rejecting legitimately-unsupported programs.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COLLECTIONS, parseKbFile } from "./frontmatter";

/** A program id that is never valid — it's a near-miss of a real, searchable one. */
const KNOWN_DRIFT: Record<string, string> = {
  qatarairways: "qatar",
  americanairlines: "american",
};

async function loadAllPrograms(): Promise<{ file: string; programs: string[] }[]> {
  const root = path.resolve(process.cwd(), "knowledge");
  const results: { file: string; programs: string[] }[] = [];
  for (const collection of COLLECTIONS) {
    const dir = path.join(root, collection);
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const file of files) {
      const rel = `${collection}/${file}`;
      const raw = await readFile(path.join(dir, file), "utf8");
      const { frontmatter } = parseKbFile(raw, rel);
      results.push({ file: rel, programs: frontmatter.programs });
    }
  }
  return results;
}

describe("[REGRESSION] knowledge-doc program identifiers", () => {
  it("never uses a known-drifted spelling of a real seats.aero program id", async () => {
    const docs = await loadAllPrograms();
    const offenders = docs.flatMap(({ file, programs }) =>
      programs.filter((p) => p in KNOWN_DRIFT).map((p) => `${file}: "${p}" should be "${KNOWN_DRIFT[p]}"`),
    );
    expect(offenders).toEqual([]);
  });
});

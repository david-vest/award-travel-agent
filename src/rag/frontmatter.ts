import matter from "gray-matter";
import { z } from "zod";

export const COLLECTIONS = [
  "sweet-spots",
  "transfers",
  "booking",
  "seasonality",
  "products",
] as const;

export type Collection = (typeof COLLECTIONS)[number];

const base = z.object({
  id: z.string().min(1),
  collection: z.enum(COLLECTIONS),
  /** ISO date. Surfaced in citations so opinions carry a freshness stamp. */
  updated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  airlines: z.array(z.string()).default([]),
  aircraft: z.array(z.string()).default([]),
  programs: z.array(z.string()).default([]),
  regions: z.array(z.string()).default([]),
  cabin: z.enum(["economy", "premium", "business", "first"]).optional(),
  sources: z.array(z.string().url()).default([]),
});

/**
 * Product reviews are editorial opinion, so they must carry sources. Everything
 * else may be a factual statement about a program's own rules, which does not.
 */
export const frontmatterSchema = base.refine(
  (fm) => fm.collection !== "products" || fm.sources.length > 0,
  { message: "products documents require at least one source URL" },
);

export type KbFrontmatter = z.infer<typeof base>;

export function parseKbFile(
  raw: string,
  filePath: string,
): { frontmatter: KbFrontmatter; body: string } {
  const { data, content } = matter(raw);

  // gray-matter turns unquoted YAML dates into Date objects; normalize back.
  if (data.updated instanceof Date) {
    data.updated = data.updated.toISOString().slice(0, 10);
  }

  const parsed = frontmatterSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(
      `Invalid frontmatter in ${filePath}: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }

  const body = content.trim();
  if (body.length === 0) {
    throw new Error(`Empty body in ${filePath}`);
  }

  return { frontmatter: parsed.data as KbFrontmatter, body };
}

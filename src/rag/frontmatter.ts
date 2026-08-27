import matter from "gray-matter";
import { z } from "zod";

export const COLLECTIONS = [
  "sweet-spots",
  "transfers",
  "booking",
  "seasonality",
  "products",
  "airports",
] as const;

export const SCORING_DIMENSIONS = [
  "cabin_product",
  "booking_ease",
  "transfer_risk",
  "connection_quality",
] as const;

export type ScoringDimension = (typeof SCORING_DIMENSIONS)[number];

export type Collection = (typeof COLLECTIONS)[number];

const base = z.object({
  id: z.string().min(1),
  collection: z.enum(COLLECTIONS),
  /** ISO date. Surfaced in citations so opinions carry a freshness stamp. */
  updated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  airlines: z.array(z.string()).default([]),
  aircraft: z.array(z.string()).default([]),
  programs: z.array(z.string()).default([]),
  creditPrograms: z.array(z.string()).default([]),
  regions: z.array(z.string()).default([]),
  airports: z.array(z.string().length(3)).default([]),
  routes: z.array(z.string().regex(/^[A-Z]{3}-[A-Z]{3}$/)).default([]),
  dimensions: z.array(z.enum(SCORING_DIMENSIONS)).default([]),
  cabin: z.enum(["economy", "premium", "business", "first"]).optional(),
  productName: z.string().trim().min(1).optional(),
  reviewAfter: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sources: z.array(z.string().url()).default([]),
});

/**
 * Any document allowed to influence ranking must be auditable. General
 * knowledge can still be source-free, but adding a scoring dimension opts the
 * document into the stricter evidence contract.
 */
export const frontmatterSchema = base.refine(
  (fm) => fm.collection !== "products" || fm.sources.length > 0,
  { message: "products documents require at least one source URL" },
).refine(
  (fm) => fm.dimensions.length === 0 || fm.sources.length > 0,
  { message: "documents that affect scoring require at least one source URL" },
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
  if (data.reviewAfter instanceof Date) {
    data.reviewAfter = data.reviewAfter.toISOString().slice(0, 10);
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

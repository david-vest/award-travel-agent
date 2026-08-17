// evals/evaluators/plan-similarity.ts

/** F1 over sets. Partial credit matters: ORD-without-MDW is nearly right. */
export function setF1(actual: string[], expected: string[]): number {
  const a = new Set(actual);
  const e = new Set(expected);
  if (a.size === 0 && e.size === 0) return 1;
  if (a.size === 0 || e.size === 0) return 0;

  let overlap = 0;
  for (const x of a) if (e.has(x)) overlap++;
  if (overlap === 0) return 0;

  const precision = overlap / a.size;
  const recall = overlap / e.size;
  return (2 * precision * recall) / (precision + recall);
}

type Window = { start?: string; end?: string };

/** Intersection over union on date ranges. */
export function windowIoU(a: Window, b: Window): number {
  if (!a.start && !a.end && !b.start && !b.end) return 1;
  if (!a.start || !a.end || !b.start || !b.end) return 0;

  const [aStart, aEnd] = [Date.parse(a.start), Date.parse(a.end)];
  const [bStart, bEnd] = [Date.parse(b.start), Date.parse(b.end)];

  const intersection = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  const union = Math.max(aEnd, bEnd) - Math.min(aStart, bStart);
  return union <= 0 ? 1 : intersection / union;
}

/** Field weights. Origins and destinations dominate: get those wrong and the
 *  search is meaningless, whereas a slightly-off date window still returns
 *  useful results. */
const WEIGHTS = {
  origins: 0.3,
  destinations: 0.3,
  cabins: 0.15,
  nonstopOnly: 0.1,
  window: 0.15,
} as const;

export function planSimilarity(args: {
  outputs: Record<string, unknown>;
  referenceOutputs?: Record<string, unknown>;
}): { key: string; score: number; comment: string } {
  const actual = args.outputs ?? {};
  const expected = args.referenceOutputs ?? {};

  const scores = {
    origins: setF1(
      (actual.origins as string[]) ?? [],
      (expected.origins as string[]) ?? [],
    ),
    destinations: setF1(
      (actual.destinations as string[]) ?? [],
      (expected.destinations as string[]) ?? [],
    ),
    cabins: setF1(
      (actual.cabins as string[]) ?? [],
      (expected.cabins as string[]) ?? [],
    ),
    nonstopOnly:
      Boolean(actual.nonstopOnly) === Boolean(expected.nonstopOnly) ? 1 : 0,
    window: windowIoU(
      { start: actual.startDate as string, end: actual.endDate as string },
      { start: expected.startDate as string, end: expected.endDate as string },
    ),
  };

  const score = (Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>).reduce(
    (total, field) => total + scores[field] * WEIGHTS[field],
    0,
  );

  const weakest = (Object.keys(scores) as Array<keyof typeof scores>)
    .filter((f) => scores[f] < 1)
    .map((f) => `${f}=${scores[f].toFixed(2)}`);

  return {
    key: "plan_similarity",
    score,
    comment: weakest.length > 0 ? `lost points on ${weakest.join(", ")}` : "exact",
  };
}

import { createHash } from "node:crypto";

/**
 * Deterministic cache key for a seats.aero request.
 *
 * Two normalizations matter:
 *  - keys are sorted, so object literal ordering never fragments the cache
 *  - comma-delimited lists are sorted, so "ORD,MDW" and "MDW,ORD" are one entry
 *
 * Both exist because the planner assembles these params from an LLM's output,
 * where ordering is not stable across runs.
 */
export function requestKey(
  endpoint: string,
  params: Record<string, unknown>,
): string {
  const normalized = Object.entries(params)
    .filter(([k, v]) => {
      if (v === undefined || v === null || v === "") return false;
      if (k === "cursor" && v === 0) return false;
      // Assumes every boolean param's omitted default is false — currently
      // true only for only_direct_flights. Revisit if a boolean param is
      // ever added whose default is true.
      if (v === false) return false;
      return true;
    })
    .map(([k, v]) => [k, normalizeValue(v)] as const)
    .sort(([a], [b]) => a.localeCompare(b));

  const payload = JSON.stringify([endpoint, normalized]);
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

function normalizeValue(v: unknown): string {
  const s = String(v);
  if (!s.includes(",")) return s;
  return s
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .sort()
    .join(",");
}

// app/components/CostHud.tsx
"use client";

import type { CostSummary } from "@/src/agent/stream";

/**
 * Development-only. Cost is invisible without instrumentation, and prompt
 * caching in particular is impossible to verify by eye — a cache hit rate
 * stuck at 0% means a prefix is being invalidated somewhere.
 */
export function CostHud({
  cost,
  sessionTotal,
}: {
  cost: CostSummary | null;
  sessionTotal: number;
}) {
  if (process.env.NODE_ENV === "production") return null;
  if (!cost) return null;

  const pct = (cost.cacheHitRate * 100).toFixed(0);
  const warn = cost.cacheHitRate === 0;

  return (
    <aside className="cost-hud">
      <h2>Cost</h2>
      <dl>
        <dt>This turn</dt>
        <dd>${cost.usd.toFixed(4)}</dd>

        <dt>Session</dt>
        <dd>${sessionTotal.toFixed(4)}</dd>

        <dt>Cache hits</dt>
        <dd className={warn ? "warn" : undefined}>
          {pct}%{warn ? " — prefix may be invalidating" : ""}
        </dd>

        <dt>seats.aero quota</dt>
        <dd>{cost.quotaRemaining ?? "unknown"}</dd>
      </dl>

      <details>
        <summary>Per node</summary>
        <ul>
          {cost.perNode
            .sort((a, b) => b.usd - a.usd)
            .map((n) => (
              <li key={n.node}>
                <span>{n.node}</span>
                <span>${n.usd.toFixed(4)}</span>
              </li>
            ))}
        </ul>
      </details>
    </aside>
  );
}

import { findViolations } from "../../src/agent/nodes/verify";
import type { AgentStateType } from "../../src/agent/state";

/**
 * Zero LLM calls, zero cost, zero flake. Extract every mileage figure, flight
 * number, and airline code from the answer and test set membership against the
 * tool results. For "did the model invent a flight", this is strictly better
 * than a judge: faster, free, and incapable of being wrong about it.
 */
export function hallucinationCheck(args: {
  outputs: Record<string, unknown>;
}): { key: string; score: number; comment: string } {
  const draft = String(args.outputs?.draft ?? "");
  const state = args.outputs?.state as AgentStateType | undefined;

  if (!state) {
    return { key: "groundedness", score: 0, comment: "no state captured" };
  }

  const violations = findViolations(draft, state);

  return {
    key: "groundedness",
    score: violations.length === 0 ? 1 : 0,
    comment:
      violations.length === 0
        ? "every figure traced to tool results"
        : violations.map((v) => `${v.kind}: ${v.detail}`).join(" | "),
  };
}

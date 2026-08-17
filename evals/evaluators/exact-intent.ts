/**
 * No LLM. "Did the classifier output the expected label?" is a string
 * comparison — running a judge over it would cost money, add latency, and
 * introduce a second thing capable of being wrong.
 */
export function exactIntent(args: {
  outputs: Record<string, unknown>;
  referenceOutputs?: Record<string, unknown>;
}): { key: string; score: number } {
  const actual = args.outputs?.intent;
  const expected = args.referenceOutputs?.intent;
  return {
    key: "intent_exact_match",
    score: actual !== undefined && actual === expected ? 1 : 0,
  };
}

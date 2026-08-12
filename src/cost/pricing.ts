/**
 * Claude Sonnet 5 pricing, USD per million tokens.
 *
 * Introductory pricing ($2 / $10) applies through 2026-08-31. After that the
 * standard rate ($3 / $15) takes over. If you are reading this after that date
 * and the numbers look wrong, INTRO_UNTIL is the thing to check.
 */
const INTRO_UNTIL = new Date("2026-09-01T00:00:00Z");

const RATES = {
  intro: { input: 2.0, output: 10.0 },
  standard: { input: 3.0, output: 15.0 },
} as const;

/** Cache reads bill at 0.1x base input; 5-minute-TTL writes at 1.25x. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

const PER_MILLION = 1_000_000;

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};

export const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
});

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens:
      a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  };
}

export function costOf(usage: TokenUsage, at: Date = new Date()): number {
  const rate = at < INTRO_UNTIL ? RATES.intro : RATES.standard;
  const inputCost =
    (usage.inputTokens * rate.input +
      usage.cacheReadInputTokens * rate.input * CACHE_READ_MULTIPLIER +
      usage.cacheCreationInputTokens * rate.input * CACHE_WRITE_MULTIPLIER) /
    PER_MILLION;
  const outputCost = (usage.outputTokens * rate.output) / PER_MILLION;
  return inputCost + outputCost;
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(n < 0.01 && n > 0 ? 6 : 4)}`;
}

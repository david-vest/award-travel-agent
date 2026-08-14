import { SystemMessage } from "@langchain/core/messages";

/**
 * Sonnet 5 will not create a cache entry for a prefix shorter than this. Below
 * it, a cache_control marker is silently ignored — no error, and
 * cache_creation_input_tokens stays 0. Marking short prompts is therefore not
 * harmless: it looks like caching is configured when it is not.
 */
export const CACHE_MIN_TOKENS = 1024;

/** Rough 4-chars-per-token heuristic — only used to catch obvious mistakes. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * A system message whose content block is marked for ephemeral caching.
 * Only use this for genuinely frozen, long prompts — anything interpolated
 * with a changing value invalidates the prefix on every request.
 */
export function cachedSystem(text: string): SystemMessage {
  const tokens = estimateTokens(text);
  if (tokens < CACHE_MIN_TOKENS) {
    throw new Error(
      `Prompt is ~${tokens} tokens, below the ${CACHE_MIN_TOKENS}-token cache ` +
        `minimum. cache_control would be silently ignored. Use plainSystem().`,
    );
  }

  return new SystemMessage({
    content: [{ type: "text", text, cache_control: { type: "ephemeral" } }],
  });
}

export function plainSystem(text: string): SystemMessage {
  return new SystemMessage(text);
}

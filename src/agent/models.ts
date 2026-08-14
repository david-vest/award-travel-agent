import { ChatAnthropic } from "@langchain/anthropic";

export const MODEL_ID = "claude-sonnet-5";

export type Effort = "low" | "medium" | "high";

/**
 * maxTokens caps thinking AND response text together on Sonnet 5, where
 * thinking is on by default. Classification nodes emit a few tokens but still
 * need headroom to think; synthesis needs room for a real answer.
 */
const MAX_TOKENS: Record<Effort, number> = {
  low: 4_000,
  medium: 16_000,
  high: 32_000,
};

/**
 * Never pass temperature, topP, or topK. Sonnet 5 returns HTTP 400 on
 * non-default sampling parameters, and `temperature: 0` is the single most
 * common way to break a ChatAnthropic setup on this model.
 */
export function chat(opts: {
  effort: Effort;
  maxTokens?: number;
  /** Set "summarized" only where reasoning is streamed to a user. */
  thinkingDisplay?: "omitted" | "summarized";
  /**
   * Anthropic's structured output relies on forced tool calling, which the
   * SDK itself warns is "not supported when `thinking` is enabled" — it can
   * raise OutputParserException if the model doesn't reliably call the
   * forced tool. Callers that immediately chain `.withStructuredOutput(...)`
   * should set this to disable thinking at the root rather than relying on
   * a try/catch fallback alone.
   */
  disableThinking?: boolean;
}): ChatAnthropic {
  return new ChatAnthropic({
    model: MODEL_ID,
    maxTokens: opts.maxTokens ?? MAX_TOKENS[opts.effort],
    // Native constructor fields on this @langchain/anthropic version — not
    // modelKwargs. They map 1:1 to the raw Anthropic API's output_config and
    // thinking params.
    outputConfig: { effort: opts.effort },
    thinking: opts.disableThinking
      ? { type: "disabled" }
      : { type: "adaptive", display: opts.thinkingDisplay ?? "omitted" },
  });
}

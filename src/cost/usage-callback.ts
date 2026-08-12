// src/cost/usage-callback.ts
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";
import type { Serialized } from "@langchain/core/load/serializable";
import type { BaseMessage } from "@langchain/core/messages";
import {
  addUsage,
  costOf,
  emptyUsage,
  formatUsd,
  type TokenUsage,
} from "./pricing";

/** Pulls Anthropic's usage block out of an LLMResult, tolerating shape drift. */
export function extractUsage(output: LLMResult): TokenUsage {
  const gen = output.generations?.[0]?.[0] as
    | { message?: { response_metadata?: Record<string, unknown>; usage_metadata?: Record<string, unknown> } }
    | undefined;

  const raw = gen?.message?.response_metadata?.usage as
    | Record<string, number>
    | undefined;

  if (raw) {
    return {
      inputTokens: raw.input_tokens ?? 0,
      outputTokens: raw.output_tokens ?? 0,
      cacheCreationInputTokens: raw.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: raw.cache_read_input_tokens ?? 0,
    };
  }

  // Fallback: LangChain's normalized shape.
  const meta = gen?.message?.usage_metadata as
    | {
        input_tokens?: number;
        output_tokens?: number;
        input_token_details?: { cache_read?: number; cache_creation?: number };
      }
    | undefined;

  return {
    inputTokens: meta?.input_tokens ?? 0,
    outputTokens: meta?.output_tokens ?? 0,
    cacheCreationInputTokens: meta?.input_token_details?.cache_creation ?? 0,
    cacheReadInputTokens: meta?.input_token_details?.cache_read ?? 0,
  };
}

export class UsageTracker extends BaseCallbackHandler {
  name = "usage-tracker";
  perNode = new Map<string, TokenUsage>();

  /**
   * `handleLLMEnd` does not receive the run's `metadata` in the installed
   * `@langchain/core` (its 5th argument is `extraParams`, not `metadata` —
   * see the deviation note in the task report). `handleChatModelStart` and
   * `handleLLMStart` DO receive `metadata` as their 7th argument, and
   * LangGraph stamps `langgraph_node` into that metadata for every model
   * call made inside a node. So the node name is captured at call-start,
   * keyed by runId, and looked back up when the matching call ends.
   */
  private runIdToNode = new Map<string, string>();

  /** Number of runs awaiting their end/error callback. Test-only accessor. */
  get pendingRuns(): number {
    return this.runIdToNode.size;
  }

  /** Directly record usage against a node. Public so tests need no LLM. */
  record(node: string, usage: TokenUsage): void {
    const prev = this.perNode.get(node) ?? emptyUsage();
    this.perNode.set(node, addUsage(prev, usage));
  }

  private captureNode(
    runId: string,
    metadata?: Record<string, unknown>,
  ): void {
    const node = metadata?.langgraph_node;
    if (typeof node === "string") {
      this.runIdToNode.set(runId, node);
    }
  }

  async handleChatModelStart(
    _llm: Serialized,
    _messages: BaseMessage[][],
    runId: string,
    _parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    this.captureNode(runId, metadata);
  }

  async handleLLMStart(
    _llm: Serialized,
    _prompts: string[],
    runId: string,
    _parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    this.captureNode(runId, metadata);
  }

  async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
    const node = this.runIdToNode.get(runId) ?? "unknown";
    this.runIdToNode.delete(runId);
    this.record(node, extractUsage(output));
  }

  /**
   * A failed call invokes this instead of `handleLLMEnd` — for both chat
   * models and plain LLMs, since the installed `@langchain/core` routes
   * both through the same `CallbackManagerForLLMRun.handleLLMError`
   * (there is no separate `handleChatModelError` hook in this version;
   * checked `dist/callbacks/manager.js` and found no such method anywhere
   * in `@langchain/core` or `@langchain/anthropic`). Without this, any run
   * captured in `handleChatModelStart`/`handleLLMStart` that then errors
   * would leave its `runId` entry in `runIdToNode` forever.
   */
  async handleLLMError(_err: unknown, runId: string): Promise<void> {
    this.runIdToNode.delete(runId);
  }

  total(): TokenUsage {
    return [...this.perNode.values()].reduce(addUsage, emptyUsage());
  }

  /**
   * Share of input tokens served from cache. Output tokens are excluded — they
   * are never cacheable, and including them would flatter the number.
   */
  cacheHitRate(): number {
    const t = this.total();
    const denominator = t.cacheReadInputTokens + t.inputTokens;
    return denominator === 0 ? 0 : t.cacheReadInputTokens / denominator;
  }

  report(): string {
    const rows = [...this.perNode.entries()].map(([node, u]) => {
      const cost = formatUsd(costOf(u));
      return `  ${node.padEnd(22)} in ${String(u.inputTokens).padStart(7)}  cached ${String(u.cacheReadInputTokens).padStart(7)}  written ${String(u.cacheCreationInputTokens).padStart(7)}  out ${String(u.outputTokens).padStart(6)}  ${cost}`;
    });

    const t = this.total();
    const rate = `${(this.cacheHitRate() * 100).toFixed(1)}%`;

    return [
      "",
      "─── token usage ───────────────────────────────────────────────",
      ...rows,
      `  ${"TOTAL".padEnd(22)} in ${String(t.inputTokens).padStart(7)}  cached ${String(t.cacheReadInputTokens).padStart(7)}  written ${String(t.cacheCreationInputTokens).padStart(7)}  out ${String(t.outputTokens).padStart(6)}  ${formatUsd(costOf(t))}`,
      `  cache hit rate: ${rate}`,
      "───────────────────────────────────────────────────────────────",
      "",
    ].join("\n");
  }
}

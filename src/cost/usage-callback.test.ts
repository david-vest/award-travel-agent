// src/cost/usage-callback.test.ts
import { describe, it, expect } from "vitest";
import { UsageTracker } from "./usage-callback";

// Minimal stand-in for the LLMResult shape the handler reads.
const llmResult = (usage: Record<string, number>) =>
  ({
    generations: [[]],
    llmOutput: {},
    // ChatAnthropic surfaces per-generation message metadata here
    ...{ __usage: usage },
  }) as never;

describe("UsageTracker", () => {
  it("attributes usage to the node named in metadata", () => {
    const t = new UsageTracker();
    t.record("synthesize", {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 900,
    });

    expect(t.perNode.get("synthesize")?.inputTokens).toBe(100);
    expect(t.perNode.get("synthesize")?.cacheReadInputTokens).toBe(900);
  });

  it("accumulates repeated calls to the same node", () => {
    const t = new UsageTracker();
    const u = {
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    t.record("triage", u);
    t.record("triage", u);

    expect(t.perNode.get("triage")?.inputTokens).toBe(20);
    expect(t.total().outputTokens).toBe(10);
  });

  it("computes cache hit rate over input tokens only", () => {
    const t = new UsageTracker();
    t.record("synthesize", {
      inputTokens: 100,
      outputTokens: 999,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 900,
    });

    expect(t.cacheHitRate()).toBeCloseTo(0.9, 6);
  });

  it("reports a zero hit rate when nothing was cached", () => {
    const t = new UsageTracker();
    t.record("triage", {
      inputTokens: 100,
      outputTokens: 10,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });

    expect(t.cacheHitRate()).toBe(0);
  });

  it("renders a report naming each node", () => {
    const t = new UsageTracker();
    t.record("triage", {
      inputTokens: 100,
      outputTokens: 10,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });

    const report = t.report();
    expect(report).toContain("triage");
    expect(report).toContain("TOTAL");
  });
});

// Fake LLMResult in the shape `extractUsage` reads: raw Anthropic usage on
// `generations[0][0].message.response_metadata.usage`.
const fakeLlmResult = (usage: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}) =>
  ({
    generations: [
      [
        {
          message: {
            response_metadata: { usage },
          },
        },
      ],
    ],
    llmOutput: {},
  }) as never;

describe("UsageTracker callback wiring (handleChatModelStart/handleLLMEnd/handleLLMError)", () => {
  it("attributes usage to the node captured at call-start, looked up by runId at call-end", async () => {
    const t = new UsageTracker();

    await t.handleChatModelStart(
      {} as never,
      [] as never,
      "run-1",
      undefined,
      undefined,
      undefined,
      { langgraph_node: "some_node" },
    );
    await t.handleLLMEnd(
      fakeLlmResult({
        input_tokens: 42,
        output_tokens: 7,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 10,
      }),
      "run-1",
    );

    expect(t.perNode.get("some_node")?.inputTokens).toBe(42);
    expect(t.perNode.get("some_node")?.outputTokens).toBe(7);
    expect(t.perNode.get("some_node")?.cacheReadInputTokens).toBe(10);
  });

  it("falls back to 'unknown' when handleLLMEnd's runId was never seen by a start handler", async () => {
    const t = new UsageTracker();

    await t.handleLLMEnd(
      fakeLlmResult({
        input_tokens: 5,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
      "never-seen-run",
    );

    expect(t.perNode.get("unknown")?.inputTokens).toBe(5);
  });

  it("clears the pending runId entry on handleLLMError, not just on handleLLMEnd", async () => {
    const t = new UsageTracker();

    await t.handleChatModelStart(
      {} as never,
      [] as never,
      "run-2",
      undefined,
      undefined,
      undefined,
      { langgraph_node: "some_node" },
    );
    expect(t.pendingRuns).toBe(1);

    await t.handleLLMError(new Error("boom"), "run-2");

    expect(t.pendingRuns).toBe(0);
  });
});

describe("UsageTracker.reset()", () => {
  it("clears all accumulated usage and pending runs", () => {
    const t = new UsageTracker();

    t.record("synthesize", {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 25,
      cacheReadInputTokens: 900,
    });
    t.record("triage", {
      inputTokens: 50,
      outputTokens: 10,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });

    expect(t.perNode.size).toBe(2);
    expect(t.total().inputTokens).toBe(150);

    t.reset();

    expect(t.perNode.size).toBe(0);
    const empty = t.total();
    expect(empty.inputTokens).toBe(0);
    expect(empty.outputTokens).toBe(0);
    expect(empty.cacheCreationInputTokens).toBe(0);
    expect(empty.cacheReadInputTokens).toBe(0);
  });
});

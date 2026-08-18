import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./graph", () => ({
  buildGraph: vi.fn(),
  buildGraphWithoutCheckpointer: vi.fn(),
}));

import { buildGraph, buildGraphWithoutCheckpointer } from "./graph";

const CHECKPOINTED = { kind: "checkpointed" } as never;
const FALLBACK = { kind: "fallback" } as never;

describe("getAgentGraph", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(buildGraph).mockReset();
    vi.mocked(buildGraphWithoutCheckpointer).mockReset();
    vi.mocked(buildGraphWithoutCheckpointer).mockReturnValue(FALLBACK);
  });

  it("returns the checkpointed graph and memoizes it once buildGraph succeeds", async () => {
    vi.mocked(buildGraph).mockResolvedValue(CHECKPOINTED);
    const { getAgentGraph: fresh } = await import("./runtime");

    const first = await fresh();
    const second = await fresh();

    expect(first).toBe(CHECKPOINTED);
    expect(second).toBe(CHECKPOINTED);
    expect(buildGraph).toHaveBeenCalledTimes(1);
  });

  it("[REGRESSION] a buildGraph() failure still returns the fallback graph for that call", async () => {
    vi.mocked(buildGraph).mockRejectedValueOnce(new Error("mongo down"));
    const { getAgentGraph: fresh } = await import("./runtime");

    const result = await fresh();

    expect(result).toBe(FALLBACK);
  });

  it("[REGRESSION] a transient buildGraph() failure is NOT cached — the next call retries buildGraph() instead of reusing the fallback forever", async () => {
    vi.mocked(buildGraph)
      .mockRejectedValueOnce(new Error("mongo down"))
      .mockResolvedValueOnce(CHECKPOINTED);
    const { getAgentGraph: fresh } = await import("./runtime");

    const first = await fresh();
    const second = await fresh();

    expect(first).toBe(FALLBACK);
    expect(second).toBe(CHECKPOINTED);
    expect(buildGraph).toHaveBeenCalledTimes(2);
  });
});

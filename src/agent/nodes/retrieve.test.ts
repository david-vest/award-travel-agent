import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStateType } from "../state";

vi.mock("../../rag/retriever", () => ({
  retrieveKnowledge: vi.fn(),
}));

vi.mock("./triage", () => ({
  lastUserText: vi.fn(() => "question"),
}));

import { retrieveKnowledge } from "../../rag/retriever";
import { retrieveKnowledgeNode } from "./retrieve";

describe("retrieveKnowledgeNode", () => {
  beforeEach(() => {
    vi.mocked(retrieveKnowledge).mockReset();
  });

  it("does not use RAG as a substitute when a flight search found nothing", async () => {
    const result = await retrieveKnowledgeNode({
      intent: "route_search",
      awardResults: [],
    } as unknown as AgentStateType);

    expect(result.kbDocs).toEqual([]);
    expect(retrieveKnowledge).not.toHaveBeenCalled();
  });

  it("still retrieves for a pure knowledge question", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValueOnce([]);

    await retrieveKnowledgeNode({
      intent: "knowledge",
      awardResults: [],
      tripSummaries: [],
    } as unknown as AgentStateType);

    expect(retrieveKnowledge).toHaveBeenCalledOnce();
  });
});

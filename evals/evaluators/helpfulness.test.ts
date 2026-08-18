import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentStateType } from "../../src/agent/state";

vi.mock("../../src/agent/models", () => ({ chat: vi.fn() }));

import { chat } from "../../src/agent/models";
import { helpfulnessJudge } from "./helpfulness";

function mockVerdict(verdict: {
  answersQuestion?: boolean;
  namesProgram?: boolean;
  givesBookingPath?: boolean;
  citesSourceWhenRelevant?: boolean;
  reasoning?: string;
}) {
  const invoke = vi.fn().mockResolvedValue({
    answersQuestion: true,
    namesProgram: true,
    givesBookingPath: true,
    citesSourceWhenRelevant: true,
    reasoning: "looks good",
    ...verdict,
  });
  vi.mocked(chat).mockReturnValue({
    withStructuredOutput: vi.fn().mockReturnValue({ invoke }),
  } as never);
}

describe("helpfulnessJudge", () => {
  beforeEach(() => vi.mocked(chat).mockReset());

  it("[REGRESSION] fails the mustMention check when the draft omits a required term, even if the judge approves", async () => {
    mockVerdict({});
    const result = await helpfulnessJudge({
      inputs: { question: "Does Chase transfer to Alaska?" },
      outputs: { draft: "Yes, several transferable card programs work for this." },
      referenceOutputs: { mustMention: ["Alaska"], shouldFindOptions: false },
    });
    expect(result.score).toBeLessThan(1);
  });

  it("passes the mustMention check when the draft contains the required term (case-insensitive)", async () => {
    mockVerdict({});
    const result = await helpfulnessJudge({
      inputs: { question: "Does Chase transfer to Alaska?" },
      outputs: { draft: "Chase does not transfer to alaska airlines directly." },
      referenceOutputs: { mustMention: ["Alaska"], shouldFindOptions: false },
    });
    expect(result.score).toBe(1);
  });

  it("[REGRESSION] flags a mismatch between shouldFindOptions and whether the search actually found options", async () => {
    mockVerdict({});
    const state = { awardResults: [{ availabilityId: "a1" }] } as unknown as AgentStateType;
    const result = await helpfulnessJudge({
      inputs: { question: "Nonstop first from JFK to SYD?" },
      outputs: { draft: "No availability found.", state },
      referenceOutputs: { mustMention: [], shouldFindOptions: false },
    });
    expect(result.score).toBeLessThan(1);
  });

  it("[REGRESSION] no longer checks for [doc-id]-style citation — the judge criteria don't include citesKnowledge", async () => {
    mockVerdict({});
    const result = await helpfulnessJudge({
      inputs: { question: "Is Qsuite worth it?" },
      outputs: { draft: "Yes, according to Qatar's own product page, Qsuite offers doors." },
      referenceOutputs: { mustMention: [], shouldFindOptions: false },
    });
    // A citesKnowledge check keyed on bracket-id citation would have no way
    // to pass here — this draft cites a source in prose, which is the only
    // form the synthesis prompt now permits.
    expect(result.score).toBe(1);
  });
});

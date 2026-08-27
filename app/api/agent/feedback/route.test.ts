import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordAgentFeedback } = vi.hoisted(() => ({ recordAgentFeedback: vi.fn() }));
vi.mock("../../../../src/observability/user-feedback", () => ({ recordAgentFeedback }));

import { POST } from "./route";

const payload = {
  runId: "10000000-0000-4000-8000-000000000000",
  kind: "rating",
  rating: "down",
  rankingVersion: "evidence-hybrid-v3",
  preferenceProfile: { experienceWeight: 50, priorities: [] },
  candidateIds: ["candidate-1"],
  evidenceIds: ["evidence-1"],
};

describe("POST /api/agent/feedback", () => {
  beforeEach(() => recordAgentFeedback.mockReset().mockResolvedValue(undefined));

  it("validates and records bounded feedback", async () => {
    const response = await POST(new Request("http://localhost/api/agent/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, pointBalances: { chase: 500_000 } }),
    }));
    expect(response.status).toBe(200);
    expect(recordAgentFeedback).toHaveBeenCalledWith(payload);
  });

  it("rejects a rating without an up or down value", async () => {
    const invalid: Record<string, unknown> = { ...payload };
    delete invalid.rating;
    const response = await POST(new Request("http://localhost/api/agent/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(invalid),
    }));
    expect(response.status).toBe(400);
    expect(recordAgentFeedback).not.toHaveBeenCalled();
  });
});

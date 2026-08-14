import { describe, it, expect } from "vitest";
import { degrade } from "./degrade";
import type { AgentStateType } from "../state";

const s = (over: Partial<AgentStateType>): AgentStateType => over as AgentStateType;

describe("degrade", () => {
  it("renders the raw award results when awardResults are present", async () => {
    const result = await degrade(
      s({
        awardResults: [
          {
            availabilityId: "a1",
            origin: "ORD",
            destination: "NRT",
            date: "2026-09-14",
            program: "aeroplan",
            cabin: "business",
            miles: 87500,
            direct: true,
            airlines: "NH",
          },
        ],
        kbDocs: [],
      }),
    );
    expect(result.draft).toContain("87,500");
    expect(result.draft).toContain("ORD");
    expect(result.draft).not.toContain("could not find award availability");
  });

  it("apologizes about availability search when there are no awardResults and no kbDocs", async () => {
    const result = await degrade(s({ awardResults: [], kbDocs: [] }));
    expect(result.draft).toContain("I could not find award availability matching that search");
  });

  it("surfaces retrieved KB excerpts instead of the availability apology for a knowledge-branch degrade", async () => {
    // The knowledge branch (triage -> retrieve_knowledge -> synthesize)
    // never runs a search, so it has no awardResults — but it DID retrieve
    // real KB docs, and the generic "no award availability" apology is
    // wrong/irrelevant for a knowledge question.
    const result = await degrade(
      s({
        awardResults: [],
        kbDocs: [
          {
            id: "ana-sweet-spot",
            collection: "sweet-spots",
            text: "ANA First via Virgin Atlantic runs 85,000 miles one-way in first class.",
            sources: [],
            updated: "2026-06-01",
          },
        ],
      }),
    );
    expect(result.draft).not.toContain("I could not find award availability matching that search");
    expect(result.draft).toContain("85,000 miles");
    expect(result.draft).toContain("knowledge base");
  });

  it("prefers the award-results path over the KB path when both are present", async () => {
    const result = await degrade(
      s({
        awardResults: [
          {
            availabilityId: "a1",
            origin: "ORD",
            destination: "NRT",
            date: "2026-09-14",
            program: "aeroplan",
            cabin: "business",
            miles: 87500,
            direct: true,
            airlines: "NH",
          },
        ],
        kbDocs: [
          {
            id: "ana-sweet-spot",
            collection: "sweet-spots",
            text: "ANA First via Virgin Atlantic runs 85,000 miles one-way in first class.",
            sources: [],
            updated: "2026-06-01",
          },
        ],
      }),
    );
    expect(result.draft).toContain("87,500");
    expect(result.draft).not.toContain("knowledge base");
  });
});

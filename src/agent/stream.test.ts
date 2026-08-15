// src/agent/stream.test.ts
import { describe, it, expect } from "vitest";
import { encodeEvent, labelFor, NODE_LABELS } from "./stream";

describe("labelFor", () => {
  it("maps node names to human phrases", () => {
    expect(labelFor("search_awards")).toMatch(/search/i);
    expect(labelFor("retrieve_knowledge")).toMatch(/knowledge|looking/i);
  });

  it("never leaks a raw node name for a known node", () => {
    for (const node of Object.keys(NODE_LABELS)) {
      expect(labelFor(node)).not.toBe(node);
    }
  });

  it("falls back to a generic phrase for an unknown node", () => {
    expect(labelFor("some_new_node")).toBe("Working…");
  });

  it("enriches the search label with the plan when one is available", () => {
    const label = labelFor("search_awards", {
      searchPlan: { origins: ["ORD"], destinations: ["NRT"], programs: ["aeroplan", "united"] },
    } as never);
    expect(label).toContain("ORD");
  });

  it("[BUG-PARTIAL-PLAN-CRASH] does not throw when the accumulated state's searchPlan is a partial delta missing origins/programs", () => {
    // route.ts accumulates streamed node updates with a shallow spread, so by
    // the time this runs, `searchPlan` can be a follow-up turn's raw delta
    // (e.g. only `cabins` changed) rather than a full merged plan.
    expect(() =>
      labelFor("search_awards", {
        searchPlan: { cabins: ["business"] },
      } as never),
    ).not.toThrow();
  });
});

describe("encodeEvent", () => {
  it("emits newline-delimited JSON", () => {
    const bytes = encodeEvent({ type: "token", text: "hi" });
    const text = new TextDecoder().decode(bytes);
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({ type: "token", text: "hi" });
  });

  it("escapes newlines inside token text rather than breaking the framing", () => {
    const text = new TextDecoder().decode(
      encodeEvent({ type: "token", text: "a\nb" }),
    );
    expect(text.split("\n").filter(Boolean)).toHaveLength(1);
  });
});

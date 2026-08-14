import { describe, it, expect } from "vitest";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import type { BaseChannel, BinaryOperatorAggregate } from "@langchain/langgraph";
import { AgentState } from "./state";

// `Annotation.Root(...).spec[key]` is typed as `BaseChannel`, but at runtime
// (@langchain/langgraph@1.4.9) it is always the BinaryOperatorAggregate
// instance that `Annotation<T>({ reducer, default })` constructs, exposing
// the reducer/default functions as `.operator` / `.initialValueFactory` (not
// `.reducer` / `.default`, as the plan's Step 1 draft assumed). This narrows
// the type to match the documented reducer-channel shape.
const asAggregate = <V, U>(channel: BaseChannel<V, U>) =>
  channel as unknown as BinaryOperatorAggregate<V, U>;

describe("AgentState", () => {
  it("appends messages rather than replacing them", () => {
    const spec = asAggregate(AgentState.spec.messages);
    // messagesStateReducer mutates lc_kwargs.id on each message, so it needs
    // real BaseMessage instances rather than the plan's bare-object fakes
    // (which crash: `Cannot set properties of undefined (setting 'id')`).
    const merged = spec.operator(
      [new HumanMessage("a")],
      [new AIMessage("b")],
    );
    expect(merged).toHaveLength(2);
  });

  it("replaces awardResults rather than appending, so a re-search does not duplicate", () => {
    const spec = asAggregate(AgentState.spec.awardResults);
    const merged = spec.operator([{ availabilityId: "a" } as never], [
      { availabilityId: "b" } as never,
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].availabilityId).toBe("b");
  });

  it("defaults revisionCount to zero", () => {
    expect(asAggregate(AgentState.spec.revisionCount).initialValueFactory?.()).toBe(0);
  });

  it("increments revisionCount by addition so the retry budget is countable", () => {
    const spec = asAggregate(AgentState.spec.revisionCount);
    expect(spec.operator(0, 1)).toBe(1);
    expect(spec.operator(1, 1)).toBe(2);
  });

  it("defaults collections to empty arrays", () => {
    expect(asAggregate(AgentState.spec.kbDocs).initialValueFactory?.()).toEqual([]);
    expect(asAggregate(AgentState.spec.violations).initialValueFactory?.()).toEqual([]);
  });
});

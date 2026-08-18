import { describe, expect, it } from "vitest";
import type { BaseChannel, BinaryOperatorAggregate } from "@langchain/langgraph";
import type { TripRequest } from "../../contracts/travel-search";
import { AgentState, type AgentStateType, type SearchPlan } from "../state";
import { availablePointsByProgram, describeTripRequest, prepareUiSearch } from "./prepare-ui-search";

const asAggregate = <V, U>(channel: BaseChannel<V, U>) =>
  channel as unknown as BinaryOperatorAggregate<V, U>;

const request: TripRequest = {
  origin: { code: "SFO", airports: ["SFO"], custom: false },
  destinations: [{ code: "TYO", airports: ["HND", "NRT"], custom: false }],
  startDate: "2026-09-18",
  endDate: "2026-09-27",
  flexDays: 2,
  cabins: ["business"],
  travelers: 2,
  stopPreference: "nonstop" as const,
  preferredAirlines: ["NH"],
  creditCardPrograms: ["chase"],
  awardPrograms: ["united", "virgin"],
  pointBalances: { creditCards: {}, awardPrograms: {} },
};

describe("prepareUiSearch", () => {
  it("maps explicit UI choices into a bounded, auditable search plan", async () => {
    const result = await prepareUiSearch({ tripRequest: request } as AgentStateType);

    expect(result.searchPlan).toMatchObject({
      origins: ["SFO"], destinations: ["HND", "NRT"],
      startDate: "2026-09-16", endDate: "2026-09-29",
      cabins: ["business"], programs: ["united", "virginatlantic"],
      stopPreference: "nonstop", preferredAirlines: ["NH"], travelers: 2,
    });
    expect(result.awardResults).toEqual([]);
    expect(result.recommendations).toEqual([]);
  });

  it("[REGRESSION] every UI constraint survives being written through the actual state reducer", async () => {
    const result = await prepareUiSearch({ tripRequest: request } as AgentStateType);
    const plan = asAggregate(AgentState.spec.searchPlan).operator(
      null,
      result.searchPlan as Partial<SearchPlan>,
    )!;
    // A later, unrelated follow-up (e.g. "actually nonstop only") must not
    // wipe out the constraints this turn established.
    const afterFollowUp = asAggregate(AgentState.spec.searchPlan).operator(plan, {
      nonstopOnly: true,
    })!;
    expect(afterFollowUp.stopPreference).toBe("nonstop");
    expect(afterFollowUp.preferredAirlines).toEqual(["NH"]);
    expect(afterFollowUp.travelers).toBe(2);
  });

  it("writes the selected scope into a readable thread message", () => {
    expect(describeTripRequest(request)).toContain("from SFO to TYO");
    expect(describeTripRequest(request)).toContain("±2 days");
    expect(describeTripRequest(request)).toContain("chase");
  });

  it("combines selected transferable and direct balances by booking program", async () => {
    const withBalances: TripRequest = {
      ...request,
      creditCardPrograms: ["chase", "amex"],
      awardPrograms: ["united", "virgin"],
      pointBalances: {
        creditCards: { chase: 80_000, amex: 40_000 },
        awardPrograms: { united: 10_000, virgin: 5_000 },
      },
      maxTaxesFeesUsd: 150,
    };
    expect(availablePointsByProgram(withBalances)).toEqual({
      united: 90_000,
      virginatlantic: 125_000,
    });
    const result = await prepareUiSearch({ tripRequest: withBalances } as AgentStateType);
    expect(result.searchPlan).toMatchObject({
      filterByPointBalances: true,
      availablePointsByProgram: { united: 90_000, virginatlantic: 125_000 },
      maxTaxesFeesUsd: 150,
    });
  });
});

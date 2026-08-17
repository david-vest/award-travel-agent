import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStateType } from "../state";

vi.mock("../models", () => ({ chat: vi.fn() }));

import { chat } from "../models";
import { resolveUiLocations } from "./resolve-ui-locations";

const request = {
  origin: { code: "SFO", airports: ["SFO"], custom: false },
  destinations: [{ code: "Sorrento", airports: [], custom: true }],
  startDate: "2026-09-18", endDate: "2026-09-27", flexDays: 2,
  cabins: ["business" as const], travelers: 1, stopPreference: "up_to_one" as const,
  preferredAirlines: [], creditCardPrograms: ["chase"], awardPrograms: ["united"],
};

describe("resolveUiLocations", () => {
  beforeEach(() => vi.mocked(chat).mockReset());

  it("maps a custom Sorrento request through the agent resolver", async () => {
    const invoke = vi.fn().mockResolvedValue({ resolutions: [{ requestIndex: 0, airportCodes: ["NAP"], explanation: "Naples is Sorrento's practical air gateway." }] });
    vi.mocked(chat).mockReturnValue({ withStructuredOutput: vi.fn().mockReturnValue({ invoke }) } as never);
    const result = await resolveUiLocations({ tripRequest: request } as unknown as AgentStateType);
    expect(result.tripRequest?.destinations[0].airports).toEqual(["NAP"]);
    expect(result.locationResolutions?.[0]).toMatchObject({ query: "Sorrento", airports: ["NAP"] });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("drops hallucinated IATA codes from inferred locations", async () => {
    const invoke = vi.fn().mockResolvedValue({ resolutions: [{ requestIndex: 0, airportCodes: ["ZZZ", "NAP"], explanation: "Naples is the gateway." }] });
    vi.mocked(chat).mockReturnValue({ withStructuredOutput: vi.fn().mockReturnValue({ invoke }) } as never);
    const result = await resolveUiLocations({ tripRequest: { ...request, destinations: [{ code: "Remote beach", airports: [], custom: true }] } } as unknown as AgentStateType);
    expect(result.tripRequest?.destinations[0].airports).toEqual(["NAP"]);
  });

  it("resolves a typed Seats.aero region to its provider code without calling the model", async () => {
    const result = await resolveUiLocations({
      tripRequest: { ...request, destinations: [{ code: "Asia", airports: [], custom: true }] },
    } as unknown as AgentStateType);

    expect(result.tripRequest?.destinations[0].airports).toEqual(["ASA"]);
    expect(result.locationResolutions?.[0]).toMatchObject({ query: "Asia", airports: ["ASA"] });
    expect(chat).not.toHaveBeenCalled();
  });

  it("falls back to major gateways for a region without a provider-native group", async () => {
    const result = await resolveUiLocations({
      tripRequest: { ...request, destinations: [{ code: "Africa", airports: [], custom: true }] },
    } as unknown as AgentStateType);

    expect(result.tripRequest?.destinations[0].airports).toEqual(["JNB", "CAI", "NBO", "ADD", "CMN"]);
    expect(chat).not.toHaveBeenCalled();
  });
});

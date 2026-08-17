import { describe, it, expect } from "vitest";
import { aeroConnectionsUrl } from "./deeplink";
import type { AwardOption } from "./tools";

const option: AwardOption = {
  availabilityId: "a1",
  origin: "ORD",
  destination: "NRT",
  date: "2026-09-14",
  program: "aeroplan",
  cabin: "business",
  miles: 87500,
  direct: true,
  airlines: "NH",
};

describe("aeroConnectionsUrl", () => {
  it("pins origin and destination", () => {
    const url = new URL(aeroConnectionsUrl(option));
    expect(url.searchParams.get("origin")).toBe("ORD");
    expect(url.searchParams.get("dest")).toBe("NRT");
  });

  it("uses the option's date for both ends of the window", () => {
    const url = new URL(aeroConnectionsUrl(option));
    expect(url.searchParams.get("start")).toBe("2026-09-14");
    expect(url.searchParams.get("end")).toBe("2026-09-14");
  });

  it("passes the cabin and program through", () => {
    const url = new URL(aeroConnectionsUrl(option));
    expect(url.searchParams.get("cabins")).toBe("business");
    expect(url.searchParams.get("program")).toBe("aeroplan");
  });

  it("sets direct=true only for a nonstop", () => {
    expect(
      new URL(aeroConnectionsUrl(option)).searchParams.get("direct"),
    ).toBe("true");
    expect(
      new URL(aeroConnectionsUrl({ ...option, direct: false })).searchParams.get(
        "direct",
      ),
    ).toBeNull();
  });

  it("pins a specific flight when a trip id is supplied", () => {
    const url = new URL(aeroConnectionsUrl(option, { flightId: "t1" }));
    expect(url.searchParams.get("flight")).toBe("t1");
  });

  it("omits the flight param when no trip id is supplied", () => {
    expect(
      new URL(aeroConnectionsUrl(option)).searchParams.get("flight"),
    ).toBeNull();
  });
});

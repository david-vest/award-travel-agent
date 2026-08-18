import { describe, expect, it } from "vitest";
import { bookingProgramName, bookingUrlForFlight } from "./booking-links";
import { MILEAGE_PROGRAMS } from "./tools/seats-aero/types";

const flight = {
  program: "aeroplan",
  origin: "SFO",
  destination: "NRT",
  date: "2026-09-18",
  cabin: "business",
};

describe("bookingUrlForFlight", () => {
  it("provides an HTTPS booking site for every supported seats.aero program", () => {
    for (const program of MILEAGE_PROGRAMS) {
      const url = new URL(bookingUrlForFlight({ ...flight, program }));
      expect(url.protocol, program).toBe("https:");
      expect(url.hostname, program).not.toBe("seats.aero");
    }
  });

  it("supports booking-program aliases used by the app", () => {
    expect(new URL(bookingUrlForFlight({ ...flight, program: "british" })).hostname).toBe("www.britishairways.com");
    expect(new URL(bookingUrlForFlight({ ...flight, program: "iberia" })).hostname).toBe("www.iberia.com");
  });

  it("provides a polished loyalty-program name", () => {
    expect(bookingProgramName("qantas", "qantas")).toBe("Qantas Frequent Flyer");
    expect(bookingProgramName("british", "british")).toBe("British Airways Club");
    expect(bookingProgramName("future-program", "Future Rewards")).toBe("Future Rewards");
  });

  it("falls back to a route-specific seats.aero search for an unknown future source", () => {
    const url = new URL(bookingUrlForFlight({ ...flight, program: "future-program" }));
    expect(url.hostname).toBe("seats.aero");
    expect(url.searchParams.get("origins")).toBe("SFO");
    expect(url.searchParams.get("destinations")).toBe("NRT");
    expect(url.searchParams.get("date")).toBe("2026-09-18");
    expect(url.searchParams.get("applicable_cabin")).toBe("business");
  });
});

import { describe, expect, it } from "vitest";
import { formatSchedule } from "./flight-times";

describe("formatSchedule", () => {
  it("marks a next-day arrival", () => {
    expect(formatSchedule("2026-09-01T22:20:00Z", "2026-09-02T12:30:00Z")).toBe("10:20 PM – 12:30 PM +1");
  });

  it("does not add a day marker for a same-day arrival", () => {
    expect(formatSchedule("2026-09-01T10:20:00Z", "2026-09-01T12:30:00Z")).toBe("10:20 AM – 12:30 PM");
  });
});

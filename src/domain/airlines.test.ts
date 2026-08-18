import { describe, expect, it } from "vitest";
import { SUPPORTED_AIRLINES } from "./airlines";

describe("SUPPORTED_AIRLINES", () => {
  it("matches the complete, de-duplicated AeroConnections carrier catalog", () => {
    expect(SUPPORTED_AIRLINES).toHaveLength(32);
    expect(new Set(SUPPORTED_AIRLINES.map((airline) => airline.code)).size).toBe(SUPPORTED_AIRLINES.length);
    expect(SUPPORTED_AIRLINES).toEqual(expect.arrayContaining([
      { code: "NH", name: "ANA" },
      { code: "QR", name: "Qatar" },
      { code: "UA", name: "United" },
    ]));
  });
});

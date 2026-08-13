import { describe, it, expect } from "vitest";
import { requestKey } from "./request-key";

describe("requestKey", () => {
  it("is stable regardless of key insertion order", () => {
    const a = requestKey("/search", { origin: "ORD", cabins: "business" });
    const b = requestKey("/search", { cabins: "business", origin: "ORD" });
    expect(a).toBe(b);
  });

  it("distinguishes different endpoints", () => {
    expect(requestKey("/search", { a: 1 })).not.toBe(
      requestKey("/availability", { a: 1 }),
    );
  });

  it("distinguishes different values", () => {
    expect(requestKey("/search", { origin: "ORD" })).not.toBe(
      requestKey("/search", { origin: "MDW" }),
    );
  });

  it("ignores undefined values so optional params do not fragment the cache", () => {
    const a = requestKey("/search", { origin: "ORD", cursor: undefined });
    const b = requestKey("/search", { origin: "ORD" });
    expect(a).toBe(b);
  });

  it("normalizes comma lists so ORD,MDW matches MDW,ORD", () => {
    const a = requestKey("/search", { origin_airport: "ORD,MDW" });
    const b = requestKey("/search", { origin_airport: "MDW,ORD" });
    expect(a).toBe(b);
  });

  it("treats an explicit cursor: 0 as equivalent to omitting cursor", () => {
    expect(requestKey("/search", { cursor: 0 })).toBe(requestKey("/search", {}));
  });

  it("treats an explicit only_direct_flights: false as equivalent to omitting it", () => {
    expect(requestKey("/search", { only_direct_flights: false })).toBe(
      requestKey("/search", {}),
    );
  });

  it("does not drop a non-cursor zero value", () => {
    expect(requestKey("/search", { take: 0 })).not.toBe(requestKey("/search", {}));
  });

  it("does not drop an explicit true boolean value", () => {
    expect(requestKey("/search", { only_direct_flights: true })).not.toBe(
      requestKey("/search", {}),
    );
  });
});

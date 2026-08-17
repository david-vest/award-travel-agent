import { describe, it, expect } from "vitest";
import { transferPartnersFor } from "./programs";

describe("transferPartnersFor", () => {
  it("returns only the selected cards that transfer to the program", () => {
    // Chase transfers to British Airways Club; Citi does not.
    const partners = transferPartnersFor("british", ["chase", "citi"]);
    expect(partners.map((p) => p.id)).toEqual(["chase"]);
  });

  it("returns an empty list when no selected card transfers to the program", () => {
    // Citi does not transfer to Delta.
    const partners = transferPartnersFor("delta", ["citi"]);
    expect(partners).toEqual([]);
  });

  it("returns an empty list when no cards are selected", () => {
    expect(transferPartnersFor("flyingblue", [])).toEqual([]);
  });

  it("returns every selected card that transfers, not just the first", () => {
    // Chase and Amex both transfer to Aeroplan; Citi does not.
    const partners = transferPartnersFor("aeroplan", ["chase", "amex", "citi"]);
    expect(partners.map((p) => p.id).sort()).toEqual(["amex", "chase"]);
  });
});

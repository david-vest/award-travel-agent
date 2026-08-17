import { describe, expect, it } from "vitest";
import { GET } from "../../../app/api/airports/route";

async function search(query: string) {
  const response = await GET(new Request(`http://localhost/api/airports?q=${encodeURIComponent(query)}`));
  return response.json() as Promise<Array<{
    kind: string;
    code: string;
    city: string;
    country: string;
    airports: string[];
  }>>;
}

describe("airport search route", () => {
  it.each([
    ["EUR", "EUR", "Europe — large airports"],
    ["Europe", "EUR", "Europe — large airports"],
    ["USA", "USA", "United States — large airports"],
    ["Asia", "ASA", "Asia — large airports"],
  ])("returns Seats.aero groups for %s", async (query, code, label) => {
    const results = await search(query);

    expect(results[0]).toMatchObject({
      kind: "group",
      code,
      city: label,
      airports: [code],
    });
  });

  it("continues to return ordinary airports", async () => {
    expect(await search("JFK")).toContainEqual(expect.objectContaining({
      kind: "airport",
      code: "JFK",
      airports: ["JFK"],
    }));
  });
});

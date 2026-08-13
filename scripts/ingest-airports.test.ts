import { describe, it, expect } from "vitest";
import { parseAirportsDat, toAirport, type RawAirportRow } from "./ingest-airports";

const SAMPLE_DAT = [
  `1,"Goroka Airport","Goroka","Papua New Guinea","GKA","AYGA",-6.08,145.39,5282,10,"U","Pacific/Port_Moresby","airport","OurAirports"`,
  `2,"Some Heliport, Annex B","Nowhere","Freedonia","\\N","ZZZZ",0,0,0,0,"U",\\N,"heliport","OurAirports"`,
  `3,"Charles de Gaulle Airport","Paris","France","CDG","LFPG",49.01,2.55,392,1,"E","Europe/Paris","airport","OurAirports"`,
].join("\n");

describe("parseAirportsDat", () => {
  it("parses rows and preserves commas inside quoted fields", () => {
    const rows = parseAirportsDat(SAMPLE_DAT);
    expect(rows).toHaveLength(3);
    expect(rows[1].name).toBe("Some Heliport, Annex B");
  });

  it("represents a missing IATA code as null, not the literal string", () => {
    const rows = parseAirportsDat(SAMPLE_DAT);
    expect(rows[1].iata).toBeNull();
  });

  it("unescapes RFC-style doubled quotes inside a quoted field", () => {
    const line = `4,"Magdeburg ""City"" Airport","Magdeburg","Germany","MDG","EDBM",0,0,0,1,"E","Europe/Berlin","airport","OurAirports"`;
    const rows = parseAirportsDat(line);
    expect(rows[0].name).toBe('Magdeburg "City" Airport');
  });
});

describe("toAirport", () => {
  it("maps a valid row to an Airport with the correct region", () => {
    const rows = parseAirportsDat(SAMPLE_DAT);
    const airport = toAirport(rows[0]);
    expect(airport).toMatchObject({ iata: "GKA", city: "Goroka", region: "Oceania" });
  });

  it("returns null for a row with no IATA code", () => {
    const rows = parseAirportsDat(SAMPLE_DAT);
    expect(toAirport(rows[1])).toBeNull();
  });

  it("throws naming the country when it has no region mapping", () => {
    const unmappedRow: RawAirportRow = {
      name: "Freedonia International",
      city: "Freedonia City",
      country: "Freedonia",
      iata: "FDA",
    };
    expect(() => toAirport(unmappedRow)).toThrow(/Freedonia/);
  });

  it("returns null for a row with a valid IATA code but a blank city", () => {
    const blankCityRow: RawAirportRow = {
      name: "Some Airfield",
      city: "",
      country: "Australia",
      iata: "ARY",
    };
    expect(toAirport(blankCityRow)).toBeNull();
  });
});

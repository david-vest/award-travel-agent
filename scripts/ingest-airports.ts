// Source: OpenFlights (https://openflights.org/data.php), licensed under ODbL. Regenerate with: npm run ingest:airports
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Airport } from "../src/tools/locations/data";
import { COUNTRY_TO_REGION } from "./country-region";

const AIRPORTS_DAT_URL = "https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat";
const OUTPUT_PATH = path.resolve(import.meta.dirname, "../src/tools/locations/airports.generated.json");

export type RawAirportRow = {
  name: string;
  city: string;
  country: string;
  iata: string | null;
};

/** Parses one line of OpenFlights' quoted-CSV format into its raw fields. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);

  return fields;
}

/**
 * Parses OpenFlights' `airports.dat` format: 14 unheaded, comma-separated
 * columns per row, with some quoted fields (e.g. airport names) containing
 * literal commas. Missing values are represented as the literal string `\N`.
 *
 * Only the columns this project needs are extracted: name (1), city (2),
 * country (3), and IATA code (4, 0-indexed).
 */
export function parseAirportsDat(raw: string): RawAirportRow[] {
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const fields = parseCsvLine(line);
      const iata = fields[4];
      return {
        name: fields[1],
        city: fields[2],
        country: fields[3],
        iata: iata && iata !== "\\N" ? iata : null,
      };
    });
}

/**
 * Converts a raw OpenFlights row into an `Airport`. Returns `null` for rows
 * without a valid 3-letter IATA code, or without a city name (unusable for
 * city-based resolution). Throws, naming the country, if the row's country
 * has no entry in `COUNTRY_TO_REGION` — a mapping gap is never silently
 * dropped.
 */
export function toAirport(row: RawAirportRow): Airport | null {
  if (!row.iata || !/^[A-Z]{3}$/.test(row.iata)) {
    return null;
  }
  if (!row.city || row.city.trim().length === 0) {
    return null;
  }

  const region = COUNTRY_TO_REGION[row.country];
  if (!region) {
    throw new Error(`No region mapping for country "${row.country}" (airport ${row.iata})`);
  }

  return {
    iata: row.iata,
    city: row.city,
    country: row.country,
    region,
  };
}

export async function main(): Promise<void> {
  const res = await fetch(AIRPORTS_DAT_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${AIRPORTS_DAT_URL}: ${res.status} ${res.statusText}`);
  }
  const raw = await res.text();

  const rows = parseAirportsDat(raw);
  const rowsWithIata = rows.filter((row) => row.iata !== null);

  const airports: Airport[] = [];
  const unmappedCountries = new Set<string>();

  for (const row of rowsWithIata) {
    try {
      const airport = toAirport(row);
      if (airport) {
        airports.push(airport);
      }
    } catch {
      unmappedCountries.add(row.country);
    }
  }

  if (unmappedCountries.size > 0) {
    throw new Error(
      `COUNTRY_TO_REGION is missing ${unmappedCountries.size} countr${unmappedCountries.size === 1 ? "y" : "ies"} found in the live dataset: ${[...unmappedCountries].sort().join(", ")}`,
    );
  }

  airports.sort((a, b) => a.iata.localeCompare(b.iata));

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(airports, null, 2));

  console.log(`parsed: ${rows.length}`);
  console.log(`with IATA code: ${rowsWithIata.length}`);
  console.log(`written: ${airports.length}`);
  console.log(`-> ${OUTPUT_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

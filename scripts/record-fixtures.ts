import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { LiveSeatsAeroClient } from "../src/tools/seats-aero/live";
import { fixtureFile, DEFAULT_FIXTURE_DIR } from "../src/tools/seats-aero/replay";

/**
 * The fixed query set every reviewer's offline run depends on. Keep it small —
 * each entry costs one call against a 1,000/day quota — but make sure it covers
 * every branch the eval datasets exercise.
 */
const RECORDINGS: Array<{ endpoint: string; params: Record<string, unknown> }> = [
  // route_search branch: the "non-stop Asia in J" example question
  { endpoint: "/search", params: { origin_airport: "ORD,MDW", destination_airport: "NRT,HND,ICN,PVG,HKG,SIN,BKK,TPE", cabins: "business", only_direct_flights: true, start_date: "2026-09-01", end_date: "2026-10-31" } },
  { endpoint: "/search", params: { origin_airport: "ORD", destination_airport: "NRT", cabins: "business,first", start_date: "2026-09-01", end_date: "2026-09-30" } },
  { endpoint: "/search", params: { origin_airport: "ORD,MDW", destination_airport: "LHR,CDG,FRA,AMS", cabins: "business", start_date: "2026-09-01", end_date: "2026-09-30" } },

  // discovery branch: region-scoped bulk availability, a few programs
  { endpoint: "/availability", params: { source: "aeroplan", origin_region: "North America", destination_region: "Europe", cabin: "business", start_date: "2026-09-01", end_date: "2026-09-30" } },
  { endpoint: "/availability", params: { source: "united", origin_region: "North America", destination_region: "Asia", cabin: "business", start_date: "2026-09-01", end_date: "2026-09-30" } },
  { endpoint: "/availability", params: { source: "flyingblue", origin_region: "North America", destination_region: "Europe", cabin: "economy", start_date: "2026-09-01", end_date: "2026-09-30" } },

  // route graph, best-effort
  { endpoint: "/routes", params: { source: "aeroplan" } },
];

async function main() {
  const key = process.env.SEATS_AERO_API_KEY;
  if (!key) {
    console.error("SEATS_AERO_API_KEY is required to record fixtures.");
    process.exit(1);
  }

  await mkdir(DEFAULT_FIXTURE_DIR, { recursive: true });
  const client = new LiveSeatsAeroClient(key);
  const manifest: Record<string, unknown> = {};

  for (const { endpoint, params } of RECORDINGS) {
    const file = fixtureFile(endpoint, params);
    process.stdout.write(`recording ${endpoint} ${JSON.stringify(params)}\n`);

    try {
      const body = await callEndpoint(client, endpoint, params);
      await writeFile(
        path.join(DEFAULT_FIXTURE_DIR, file),
        JSON.stringify(body, null, 2),
      );
      manifest[file] = { endpoint, params, recordedAt: new Date().toISOString() };
      const q = client.quota();
      process.stdout.write(`  ok — quota remaining: ${q.remaining ?? "unknown"}\n`);
    } catch (err) {
      process.stdout.write(`  FAILED: ${(err as Error).message}\n`);
    }
  }

  // Trip details for the first few availability IDs we just captured, so the
  // enrich_trips node has something to work with offline.
  await recordTripsFromSearches(client, manifest);

  await writeFile(
    path.join(DEFAULT_FIXTURE_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  process.stdout.write(`\nWrote ${Object.keys(manifest).length} fixtures.\n`);
}

async function callEndpoint(
  client: LiveSeatsAeroClient,
  endpoint: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (endpoint === "/search") return client.search(params as never);
  if (endpoint === "/availability") return client.regionalAvailability(params as never);
  if (endpoint === "/routes") return client.routes(String(params.source));
  throw new Error(`unrecognized endpoint ${endpoint}`);
}

async function recordTripsFromSearches(
  client: LiveSeatsAeroClient,
  manifest: Record<string, unknown>,
): Promise<void> {
  const { readFile } = await import("node:fs/promises");

  // Only harvest from fixtures THIS run wrote, and only search-shaped
  // responses (/search and /availability both return { data: AvailabilityResult[] }
  // with genuine availability IDs in data[].ID) — a prior run's /trips/*
  // fixtures share this directory but have a different shape ({ data: Trip[] }),
  // and their `ID` fields are trip IDs, not availability IDs. Globbing the
  // whole directory would re-harvest those on a second `make record` run and
  // burn quota on bogus lookups.
  const ids = new Set<string>();
  for (const [file, entry] of Object.entries(manifest)) {
    const endpoint = (entry as { endpoint?: string })?.endpoint;
    if (endpoint !== "/search" && endpoint !== "/availability") continue;

    // A file left over from a previous, possibly-interrupted run could be
    // unreadable or not valid JSON. That must not abort the whole script —
    // it would throw away every fixture already recorded above and skip
    // writing manifest.json entirely. Skip the bad file and keep going.
    let body: unknown;
    try {
      body = JSON.parse(await readFile(path.join(DEFAULT_FIXTURE_DIR, file), "utf8"));
    } catch (err) {
      process.stdout.write(
        `  skipping unreadable fixture ${file}: ${(err as Error).message}\n`,
      );
      continue;
    }
    const data = (body as { data?: Array<{ ID?: string }> })?.data;
    for (const item of data?.slice?.(0, 5) ?? []) {
      if (item?.ID) ids.add(item.ID);
    }
    if (ids.size >= 15) break;
  }

  for (const id of [...ids].slice(0, 15)) {
    const file = fixtureFile(`/trips/${id}`, {});
    try {
      const body = await client.trips(id);
      await writeFile(
        path.join(DEFAULT_FIXTURE_DIR, file),
        JSON.stringify(body, null, 2),
      );
      manifest[file] = {
        endpoint: `/trips/${id}`,
        params: {},
        recordedAt: new Date().toISOString(),
      };
      process.stdout.write(`recorded trips for ${id}\n`);
    } catch (err) {
      process.stdout.write(`  trips ${id} FAILED: ${(err as Error).message}\n`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

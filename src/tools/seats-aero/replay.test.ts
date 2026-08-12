import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ReplaySeatsAeroClient } from "./replay";
import { requestKey } from "./request-key";

let dir: string;

const params = { origin_airport: "ORD", destination_airport: "NRT" };

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fixtures-"));
  const key = requestKey("/search", params);
  await writeFile(
    path.join(dir, `${key}.json`),
    JSON.stringify({ data: [{ ID: "abc" }], count: 1, hasMore: false, cursor: 0 }),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ReplaySeatsAeroClient", () => {
  it("returns the recorded response for a known request", async () => {
    const client = new ReplaySeatsAeroClient(dir);
    const res = await client.search(params);
    expect(res.data[0].ID).toBe("abc");
  });

  it("matches regardless of param ordering", async () => {
    const client = new ReplaySeatsAeroClient(dir);
    const res = await client.search({
      destination_airport: "NRT",
      origin_airport: "ORD",
    });
    expect(res.count).toBe(1);
  });

  it("throws a helpful 404 naming the missing fixture", async () => {
    const client = new ReplaySeatsAeroClient(dir);
    await expect(
      client.search({ origin_airport: "SFO", destination_airport: "LHR" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("reports a synthetic full quota so UI code has something to render", () => {
    const client = new ReplaySeatsAeroClient(dir);
    expect(client.quota().remaining).toBe(1000);
  });

  it("returns every item as already fresh from refresh, spending nothing", async () => {
    const client = new ReplaySeatsAeroClient(dir);
    const res = await client.refresh(["a", "b"]);
    expect(res.complete).toBe(true);
    expect(res.items.every((i) => i.status === "fresh")).toBe(true);
  });
});

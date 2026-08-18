import { describe, it, expect, vi, beforeEach } from "vitest";

const pingMock = vi.fn();
const dbMock = vi.fn(() => ({ command: pingMock }));
const mongoClientMock = vi.fn();
const getVectorStoreMock = vi.fn();

vi.mock("../../../src/rag/store", () => ({
  mongoClient: () => mongoClientMock(),
  getVectorStore: () => getVectorStoreMock(),
  DB_NAME: "test-db",
}));

import { GET } from "./route";

describe("GET /api/health", () => {
  beforeEach(() => {
    pingMock.mockReset();
    dbMock.mockClear();
    mongoClientMock.mockReset();
    getVectorStoreMock.mockReset();
  });

  it("returns 200 with ok statuses when every dependency is reachable", async () => {
    mongoClientMock.mockResolvedValue({ db: dbMock });
    pingMock.mockResolvedValue({ ok: 1 });
    getVectorStoreMock.mockResolvedValue({});

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.mongo).toBe("ok");
    expect(body.rag).toBe("ok");
  });

  it("[REGRESSION] returns 503 with a per-dependency status when Mongo is unreachable", async () => {
    mongoClientMock.mockRejectedValue(new Error("connection refused"));
    getVectorStoreMock.mockResolvedValue({});

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.mongo).toBe("unreachable");
  });

  it("reports replay mode informationally without failing the health check", async () => {
    const originalKey = process.env.SEATS_AERO_API_KEY;
    delete process.env.SEATS_AERO_API_KEY;
    mongoClientMock.mockResolvedValue({ db: dbMock });
    pingMock.mockResolvedValue({ ok: 1 });
    getVectorStoreMock.mockResolvedValue({});

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.seatsAero.mode).toBe("replay");
    if (originalKey) process.env.SEATS_AERO_API_KEY = originalKey;
  });
});

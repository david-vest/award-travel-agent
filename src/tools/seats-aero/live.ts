import { SeatsAeroError, type SeatsAeroClient } from "./client";
import type {
  QuotaState,
  RefreshResponse,
  RegionalParams,
  Route,
  SearchParams,
  SearchResponse,
  Trip,
} from "./types";

const BASE_URL = "https://seats.aero/partnerapi";

type Options = { baseDelayMs?: number; maxRetries?: number };

export class LiveSeatsAeroClient implements SeatsAeroClient {
  private quotaState: QuotaState = { limit: null, remaining: null, reset: null };
  private baseDelayMs: number;
  private maxRetries: number;

  constructor(
    private apiKey: string,
    opts: Options = {},
  ) {
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  quota(): QuotaState {
    return { ...this.quotaState };
  }

  search(params: SearchParams): Promise<SearchResponse> {
    return this.get<SearchResponse>("/search", params);
  }

  regionalAvailability(params: RegionalParams): Promise<SearchResponse> {
    return this.get<SearchResponse>("/availability", params);
  }

  trips(availabilityId: string): Promise<{ data: Trip[] }> {
    return this.get<{ data: Trip[] }>(`/trips/${availabilityId}`, {});
  }

  routes(source: string): Promise<Route[]> {
    return this.get<Route[]>("/routes", { source });
  }

  async refresh(availabilityIds: string[]): Promise<RefreshResponse> {
    if (availabilityIds.length === 0 || availabilityIds.length > 250) {
      throw new SeatsAeroError(
        400,
        `refresh accepts 1-250 ids, got ${availabilityIds.length}`,
      );
    }
    return this.request<RefreshResponse>("/refresh", {
      method: "POST",
      body: JSON.stringify({ availability_ids: availabilityIds }),
      headers: { "content-type": "application/json" },
    });
  }

  private get<T>(path: string, params: Record<string, unknown>): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      qs.append(k, String(v));
    }
    const suffix = qs.toString() ? `?${qs}` : "";
    return this.request<T>(`${path}${suffix}`, { method: "GET" });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    let delay = this.baseDelayMs;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${BASE_URL}${path}`, {
          ...init,
          headers: {
            Accept: "application/json",
            "Partner-Authorization": this.apiKey,
            ...(init.headers ?? {}),
          },
        });
      } catch (err) {
        // Network-level failure (DNS, connection reset, TLS, abort): retry it
        // the same way we retry a 429, since fetch() never even got a response.
        if (attempt < this.maxRetries - 1) {
          await sleep(delay);
          delay *= 2;
          continue;
        }
        // status 0 marks a network-level failure — no HTTP response was ever
        // received, so there's no real status code to report.
        throw new SeatsAeroError(
          0,
          `network error calling ${path}: ${(err as Error).message}`,
        );
      }

      this.captureQuota(res);

      if (res.ok) {
        if (res.status === 204) return null as T;
        return (await res.json()) as T;
      }

      // 429 is the only retryable status; everything else is a real error.
      if (res.status === 429 && attempt < this.maxRetries - 1) {
        await sleep(delay);
        delay *= 2;
        continue;
      }

      const body = await res.text().catch(() => "unknown error");
      throw new SeatsAeroError(
        res.status,
        `seats.aero ${res.status} on ${path}: ${body}`,
      );
    }

    throw new SeatsAeroError(500, `max retries exceeded on ${path}`);
  }

  private captureQuota(res: Response): void {
    const num = (h: string) => {
      const v = res.headers.get(h);
      return v === null ? null : Number(v);
    };
    const limit = num("x-ratelimit-limit");
    if (limit === null) return; // endpoint did not report quota; keep last known
    this.quotaState = {
      limit,
      remaining: num("x-ratelimit-remaining"),
      reset: num("x-ratelimit-reset"),
    };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

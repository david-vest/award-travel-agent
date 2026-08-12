import { LiveSeatsAeroClient } from "./live";
import { ReplaySeatsAeroClient } from "./replay";
import type { SeatsAeroClient } from "./client";

export * from "./client";
export * from "./types";

/**
 * Live when a key is present, replay when it is not. Nothing downstream
 * branches on the mode — that is deliberate, so the graph behaves identically
 * for a reviewer with no paid key.
 */
export function createSeatsAeroClient(): SeatsAeroClient {
  const key = process.env.SEATS_AERO_API_KEY;
  return key ? new LiveSeatsAeroClient(key) : new ReplaySeatsAeroClient();
}

export function currentMode(): "live" | "replay" {
  return process.env.SEATS_AERO_API_KEY ? "live" : "replay";
}

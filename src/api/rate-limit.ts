// src/api/rate-limit.ts
//
// Per-process, in-memory sliding-window limiter. Not shared across
// instances — on a multi-instance deployment each instance tracks its own
// counters, so the effective limit is (this limit) x (instance count). A
// shared-state limiter (Mongo- or Redis-backed) is a documented follow-up,
// not attempted here: it adds a new failure mode (limiter store itself
// unavailable) this pass hasn't scoped verification for.
//
// Also per-process, not per-user: there is no authentication in this app
// (a deliberate scope decision — see the Phase 5 plan), so "key" is
// whatever the caller derives (typically a client IP), not an account id.

export type RateLimitOptions = {
  limit: number;
  windowMs: number;
};

export type RateLimitResult =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterMs: number };

const requestTimestamps = new Map<string, number[]>();

export function checkRateLimit(
  key: string,
  { limit, windowMs }: RateLimitOptions,
  now: number = Date.now(),
): RateLimitResult {
  const windowStart = now - windowMs;
  const existing = requestTimestamps.get(key) ?? [];
  const inWindow = existing.filter((t) => t > windowStart);

  if (inWindow.length >= limit) {
    const oldestInWindow = Math.min(...inWindow);
    requestTimestamps.set(key, inWindow);
    return { allowed: false, retryAfterMs: oldestInWindow + windowMs - now };
  }

  inWindow.push(now);
  requestTimestamps.set(key, inWindow);
  return { allowed: true, remaining: limit - inWindow.length };
}

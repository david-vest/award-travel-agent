# Recommendation Ranking Baseline

**Version:** `deterministic-v1`  
**Recorded:** 2026-08-26  
**Implementation:** `src/agent/nodes/rank-recommendations.ts`

This snapshot records the ranking behavior that predates preference-aware
assessment. Production traces and LangSmith eval runs carry
`ranking_version: deterministic-v1` so later hybrid experiments can be
compared against the correct baseline.

The local baseline is covered by fixture/unit tests and does not require live
award inventory:

| Scenario | Expected deterministic-v1 behavior | Regression coverage |
|---|---|---|
| Nonstop hard preference | Exclude a connecting itinerary even when it costs fewer points | `rank-recommendations.test.ts` — viable nonstop preferred carrier |
| Fees versus mileage | Prefer the higher-mileage option when the lower-mileage option's cash fees make its blended cost worse | `rank-recommendations.test.ts` — cheaper-fee, higher-miles option |
| Connection quality | Prefer the shorter layover when points, fees, and stop count are equal | `rank-recommendations.test.ts` — shorter layover |
| Positioning burden | Keep a modest exact-route preference over a slightly cheaper gateway option | `rank-recommendations.test.ts` — positioning options |
| Party eligibility | Exclude a known one-seat award for a two-traveler request | `rank-recommendations.test.ts` — insufficient confirmed seats |

## Comparison contract for hybrid-v1

The preference-aware implementation may change the winner when qualitative
journey evidence justifies it, but it must preserve the following invariants:

- known insufficient seat counts remain excluded;
- hard nonstop requests never surface connections;
- mileage and fee facts remain provider-grounded;
- exact-route and positioning options remain visibly distinguishable;
- model failure falls back to this deterministic ordering.

Run `npm test` to reproduce the local baseline. A remote LangSmith baseline can
be recorded with `npm run eval` when LangSmith, model, and embedding credentials
are configured; its metadata will include `rankingVersion: deterministic-v1`.


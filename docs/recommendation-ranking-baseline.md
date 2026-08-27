# Recommendation Ranking Baseline

**Version:** `deterministic-v1`  
**Recorded:** 2026-08-26  
**Implementation:** `src/agent/nodes/rank-recommendations.ts`

This snapshot records the ranking behavior that predates preference-aware
assessment. Production traces and LangSmith eval runs carry
`ranking_version: deterministic-v1` so later hybrid experiments can be
compared against the correct baseline.

Phase 2/3 runs use `ranking_version: deterministic-shortlist-v2`, plus
`preference_interpreter_version: bounded-v1` and
`candidate_shortlist_version: coverage-v1`. The underlying final score is
still deterministic-v1, but the assessed candidate pool is now explicitly
versioned because coverage selection can change which options reach it.

Phase 4/5 runs use `ranking_version: evidence-hybrid-v3`,
`evidence_retrieval_version: option-linked-v1`, and
`experience_assessment_version: evidence-bounded-v1`. This baseline remains
the historical comparison point; the hybrid pipeline is covered by slider
extreme, evidence isolation, validation, and deterministic fallback tests.

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

Run `npm test` to reproduce the local deterministic-score invariants. The
current `npm run eval` command identifies Phase 2/3 runs as
`deterministic-shortlist-v2`; a historical remote `deterministic-v1` experiment
must be run from the Phase 0 revision so the candidate-pool behavior is not
silently mixed with the baseline.

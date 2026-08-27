# Recommendation Evaluation Suite

Phase 10 evaluates frozen candidate facts rather than live award inventory. It compares the current `evidence-hybrid-v3` pipeline with the frozen `deterministic-v1` ordering while keeping factual authority in code.

## Run

```bash
npm run eval -- recommendations
```

This seeds and runs two LangSmith datasets:

- `award-travel-recommendation-ranking` covers hard constraints, option/evidence IDs, slider extremes, preference-aware winners, sort immutability, structured-assessment stability, pairwise preference fit, explanation quality, groundedness, and operational metrics.
- `award-travel-recommendation-reranking` proves that preference-only follow-ups reuse the cached snapshot and make zero seats.aero calls.

Fixtures live in `evals/datasets/recommendation-ranking.jsonl` and `evals/datasets/recommendation-reranking.jsonl`. Each case stores candidate facts and an accepted property set. It does not impose a universal total order where several choices can reasonably satisfy the same preference.

## Release policy

The run fails immediately as a release signal when any of these code-owned invariants is below 100%:

- hard-constraint compliance;
- recommendation, rank, and option-scoped evidence ID validity;
- zero provider calls for preference-only reranking.

The overall thresholds are 0.85 for recommendation ranking and 0.90 for reranking. LLM judges contribute only to preference fit and explanation usefulness; they cannot override the factual gates or the existing deterministic groundedness evaluator.

## Experiment metadata

Every experiment declares and records ranking version, Git SHA, environment, latency, model tokens visible in child model runs, retrieval degradation count, and provider-call count. Ranking fixtures never call seats.aero. Reranking instruments the provider factory so an accidental search is both visible and release-blocking.

## Adding cases

Promote reviewed user failures as the smallest reproducible frozen fixture. Include only facts required for the decision, use option-scoped evidence, list every viable ID, identify the lowest blended-cost winner, and allow multiple acceptable hybrid winners when the preference does not determine one unique order.

import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Client } from "langsmith";
import { evaluate, type EvaluatorT } from "langsmith/evaluation";
import { getCurrentRunTree } from "langsmith/traceable";
import { HumanMessage } from "@langchain/core/messages";
import type { BaseChannel, BinaryOperatorAggregate } from "@langchain/langgraph";
import { triage } from "../src/agent/nodes/triage";
import { planSearch } from "../src/agent/nodes/plan-search";
import {
  resetSeatsAeroClientForTests,
  setSeatsAeroClientFactory,
} from "../src/agent/nodes/search";
import { ReplaySeatsAeroClient } from "../src/tools/seats-aero/replay";
import { buildGraphWithoutCheckpointer } from "../src/agent/graph";
import { AgentState, type AgentStateType, type SearchPlan } from "../src/agent/state";
import { RECOMMENDATION_PIPELINE_VERSION } from "../src/domain/recommendation-preferences";
import { rankRecommendations } from "../src/agent/nodes/rank-recommendations";
import { assessCandidateExperience } from "../src/agent/nodes/assess-candidate-experience";
import { synthesize } from "../src/agent/nodes/synthesize";
import { applyFlightControls, DEFAULT_FLIGHT_FILTERS, FLIGHT_SORT_OPTIONS } from "../app/flight-results";
import { UsageTracker } from "../src/cost/usage-callback";
import { exactIntent } from "./evaluators/exact-intent";
import { planSimilarity } from "./evaluators/plan-similarity";
import { hallucinationCheck } from "./evaluators/hallucination";
import { helpfulnessJudge } from "./evaluators/helpfulness";
import { deterministicV1Order } from "./baselines/deterministic-v1";
import {
  costExtremeWinner,
  experienceWeightMonotonicity,
  hardConstraintCompliance,
  hybridPreferenceWinner,
  operationalHealth,
  preferenceOnlyNoSearch,
  recommendationIdValidity,
  rerankPreferenceFit,
  sortPreservesServerRanks,
  structuredAssessmentStability,
} from "./evaluators/recommendation-invariants";
import {
  explanationQualityJudge,
  preferencePairwiseJudge,
} from "./evaluators/recommendation-judges";
import type {
  OperationalMetrics,
  RecommendationEvalOutput,
  RecommendationFixture,
  RerankingEvalOutput,
  RerankingFixture,
} from "./recommendation-types";

const client = new Client();

const asAggregate = <V, U>(channel: BaseChannel<V, U>) =>
  channel as unknown as BinaryOperatorAggregate<V, U>;

/**
 * Routes a raw planSearch update through the real searchPlan channel reducer
 * (state.ts's mergeSearchPlan), the same path the checkpointer takes in
 * production. planSearch itself returns only a partial update — the fields
 * the current turn's message actually addressed — so comparing it directly
 * against a dataset written for complete, resolved plans would score
 * something the app never actually produces. See
 * src/agent/state-carryover.test.ts for the established pattern this
 * mirrors.
 */
function applyUpdate(current: SearchPlan | null, update: Partial<SearchPlan>): SearchPlan {
  return asAggregate(AgentState.spec.searchPlan).operator(current, update)!;
}

type Example = {
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
};

async function loadJsonl(name: string): Promise<Example[]> {
  const file = path.resolve(process.cwd(), "evals/datasets", `${name}.jsonl`);
  const raw = await readFile(file, "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Example);
}

/**
 * Deterministic over {input, expected} pairs, in order — a reordered dataset
 * hashes differently on purpose; example order can matter for review, so a
 * pure reordering is treated as a real content change, not a no-op.
 */
export function contentHash(examples: Example[]): string {
  const stable = JSON.stringify(examples.map((e) => ({ input: e.input, expected: e.expected })));
  return createHash("sha256").update(stable).digest("hex");
}

/**
 * Creates the dataset on first run. On later runs, detects whether the local
 * JSONL content has drifted from what's actually stored in LangSmith — by
 * comparing content hashes, not by trusting the dataset already exists — and
 * re-syncs by replacing every example, so a local edit doesn't silently keep
 * evaluating against stale reference data forever. (The JS SDK's Dataset
 * type carries no writable metadata field to stash a version marker on, so
 * this compares actual example content rather than a stored hash.)
 */
async function seedDataset(name: string, examples: Example[]): Promise<string> {
  let datasetId: string | undefined;
  for await (const ds of client.listDatasets({ datasetName: name })) {
    datasetId = ds.id;
    break;
  }

  if (!datasetId) {
    const dataset = await client.createDataset(name, {
      description: `award-travel-agent — ${name}`,
    });
    await client.createExamples({
      datasetId: dataset.id,
      inputs: examples.map((e) => e.input),
      outputs: examples.map((e) => e.expected),
    });
    process.stdout.write(`Created dataset "${name}" with ${examples.length} examples.\n`);
    return dataset.id;
  }

  const remote: { id: string; input: Record<string, unknown>; expected: Record<string, unknown> }[] = [];
  for await (const ex of client.listExamples({ datasetId })) {
    remote.push({ id: ex.id, input: ex.inputs, expected: ex.outputs ?? {} });
  }

  const localHash = contentHash(examples);
  const remoteHash = contentHash(remote.map(({ input, expected }) => ({ input, expected })));

  if (localHash !== remoteHash) {
    if (remote.length > 0) await client.deleteExamples(remote.map((r) => r.id));
    await client.createExamples({
      datasetId,
      inputs: examples.map((e) => e.input),
      outputs: examples.map((e) => e.expected),
    });
    process.stdout.write(`Dataset "${name}" changed locally — resynced ${examples.length} examples.\n`);
  }

  return datasetId;
}

/**
 * Every numeric score across every evaluator on every row, averaged. A
 * starting gate, not a tuned target — see THRESHOLDS.
 */
function averageScore(results: { results: Array<{ evaluationResults: { results: Array<{ score?: number | boolean | null }> } }> }): number {
  const scores = results.results.flatMap((row) =>
    row.evaluationResults.results
      .map((r) => r.score)
      .filter((s): s is number => typeof s === "number"),
  );
  if (scores.length === 0) return 0;
  return scores.reduce((sum, s) => sum + s, 0) / scores.length;
}

const THRESHOLDS: Record<string, number> = {
  "intent-routing": 0.95,
  "search-planning": 0.85,
  groundedness: 0.8,
  "recommendation-ranking": 0.85,
  "recommendation-reranking": 0.9,
};

let recommendationReleaseGateFailed = false;

function experimentMetadata(): Record<string, unknown> {
  let gitSha: string | undefined;
  try {
    gitSha = execSync("git rev-parse --short HEAD", { cwd: process.cwd() }).toString().trim();
  } catch {
    // Not a git checkout (e.g. a container without .git) — omit rather than fail the eval over it.
  }
  return {
    mode: "replay", // Evals never touch the live API; replay keeps them reproducible.
    environment: process.env.NODE_ENV ?? "development",
    rankingVersion: RECOMMENDATION_PIPELINE_VERSION,
    trackedMetrics: ["latency_ms", "model_tokens", "retrieval_degradations", "provider_calls"],
    ...(gitSha ? { gitSha } : {}),
  };
}

function scoreForKey(
  results: { results: Array<{ evaluationResults: { results: Array<{ key?: string; score?: number | boolean | null }> } }> },
  key: string,
): number {
  if (results.results.length === 0) return 0;
  const scores = results.results.map((row) => {
    const score = row.evaluationResults.results.find((result) => result.key === key)?.score;
    return typeof score === "number" ? score : 0;
  });
  return scores.reduce((sum, score) => sum + score, 0) / results.results.length;
}

export function averageExpectedScores(
  results: { results: Array<{ evaluationResults: { results: Array<{ key?: string; score?: number | boolean | null }> } }> },
  keys: string[],
): number {
  if (keys.length === 0) return 0;
  return keys.reduce((sum, key) => sum + scoreForKey(results, key), 0) / keys.length;
}

function modelTokensInCurrentTrace(): number {
  try {
    const root = getCurrentRunTree(true);
    if (!root) return 0;
    const visit = (run: typeof root): number => {
      const usage = run.outputs?.usage_metadata as {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
      } | undefined;
      const own = run.run_type === "llm"
        ? usage?.total_tokens ?? (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0)
        : 0;
      return own + run.child_runs.reduce((sum, child) => sum + visit(child), 0);
    };
    return visit(root);
  } catch {
    return 0;
  }
}

function totalTrackedTokens(tracker: UsageTracker): number {
  const usage = tracker.total();
  return usage.inputTokens + usage.outputTokens
    + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
}

function attachOperationalMetadata(metrics: OperationalMetrics): void {
  try {
    const run = getCurrentRunTree(true);
    if (!run) return;
    run.metadata = {
      ...run.metadata,
      latency_ms: metrics.latencyMs,
      model_tokens: metrics.modelTokens,
      retrieval_degradations: metrics.retrievalDegradations,
      provider_calls: metrics.providerCalls,
    };
  } catch {
    // Evaluation metadata must not alter the target behavior.
  }
}

function fixtureState(input: RecommendationFixture): AgentStateType {
  return {
    messages: [new HumanMessage(input.question)],
    intent: "route_search",
    searchPlan: input.searchPlan,
    awardResults: input.awardResults,
    candidateShortlist: input.candidateShortlist ?? input.awardResults,
    tripSummaries: input.tripSummaries,
    optionEvidence: input.optionEvidence,
    kbDocs: [...new Map(Object.values(input.optionEvidence).flat().map((doc) => [doc.id, doc])).values()],
    candidateAssessments: input.candidateAssessments,
    recommendationPreferences: input.recommendationPreferences,
    searchStatus: "searched",
    degradedReasons: [],
  } as unknown as AgentStateType;
}

async function recommendationTarget(input: RecommendationFixture): Promise<RecommendationEvalOutput> {
  const started = performance.now();
  const usage = new UsageTracker();
  const modelConfig = { callbacks: [usage] };
  const state = fixtureState(input);
  const hybridUpdate = await rankRecommendations(state);
  const hybrid = hybridUpdate.recommendations ?? [];
  const costUpdate = await rankRecommendations({
    ...state,
    recommendationPreferences: { ...input.recommendationPreferences, experienceWeight: 0 },
  });
  const journeyUpdate = await rankRecommendations({
    ...state,
    recommendationPreferences: { ...input.recommendationPreferences, experienceWeight: 100 },
  });

  const assessmentRuns = [];
  let assessmentDegraded = false;
  if (input.runAssessmentStability) {
    for (let repetition = 0; repetition < 2; repetition += 1) {
      const assessed = await assessCandidateExperience(state, modelConfig);
      assessmentRuns.push(assessed.candidateAssessments ?? {});
      assessmentDegraded ||= (assessed.degradedReasons ?? []).includes("candidate_assessment_failed");
    }
  }

  const rankedState = { ...state, ...hybridUpdate } as AgentStateType;
  const draft = (await synthesize(rankedState, modelConfig)).draft ?? "";
  const metrics: OperationalMetrics = {
    latencyMs: Math.round(performance.now() - started),
    modelTokens: totalTrackedTokens(usage) || modelTokensInCurrentTrace(),
    providerCalls: 0,
    retrievalDegradations: assessmentDegraded ? 1 : 0,
  };
  attachOperationalMetadata(metrics);

  return {
    hybrid,
    costExtreme: costUpdate.recommendations ?? [],
    journeyExtreme: journeyUpdate.recommendations ?? [],
    deterministicV1Order: deterministicV1Order(state),
    sortedViews: Object.fromEntries(FLIGHT_SORT_OPTIONS.map(({ value }) => [
      value,
      applyFlightControls(hybrid, value, DEFAULT_FLIGHT_FILTERS),
    ])),
    draft,
    state: { ...rankedState, draft },
    assessmentRuns,
    assessmentDegraded,
    metrics,
  };
}

async function rerankingTarget(input: RerankingFixture): Promise<RerankingEvalOutput> {
  const started = performance.now();
  const usage = new UsageTracker();
  let providerCalls = 0;
  resetSeatsAeroClientForTests();
  setSeatsAeroClientFactory(() => {
    providerCalls += 1;
    return new ReplaySeatsAeroClient();
  });
  try {
    const graph = buildGraphWithoutCheckpointer();
    const state = await graph.invoke({
      messages: [new HumanMessage(input.followUp)],
      searchPlan: input.searchPlan,
      recommendationSnapshot: input.snapshot,
    }, { callbacks: [usage] });
    const metrics: OperationalMetrics = {
      latencyMs: Math.round(performance.now() - started),
      modelTokens: totalTrackedTokens(usage) || modelTokensInCurrentTrace(),
      providerCalls,
      retrievalDegradations: state.degradedReasons?.length ?? 0,
    };
    attachOperationalMetadata(metrics);
    return {
      recommendations: state.recommendations ?? [],
      recommendationPreferences: state.recommendationPreferences,
      searchRan: providerCalls > 0,
      draft: state.draft ?? "",
      state,
      metrics,
    };
  } finally {
    resetSeatsAeroClientForTests();
  }
}

async function runRecommendationRanking(): Promise<number> {
  const name = "award-travel-recommendation-ranking";
  await seedDataset(name, await loadJsonl("recommendation-ranking"));
  const evaluatorKeys = [
    "hard_constraint_compliance",
    "recommendation_id_validity",
    "cost_extreme_winner",
    "hybrid_preference_winner",
    "experience_weight_monotonicity",
    "sort_rank_immutability",
    "structured_assessment_stability",
    "groundedness",
    "preference_pairwise",
    "explanation_quality",
    "operational_health",
  ];
  const results = await evaluate(
    async (input: Record<string, unknown>) => (
      await recommendationTarget(input as unknown as RecommendationFixture)
    ) as unknown as Record<string, unknown>,
    {
      data: name,
      evaluators: [
        hardConstraintCompliance,
        recommendationIdValidity,
        costExtremeWinner,
        hybridPreferenceWinner,
        experienceWeightMonotonicity,
        sortPreservesServerRanks,
        structuredAssessmentStability,
        hallucinationCheck,
        preferencePairwiseJudge,
        explanationQualityJudge,
        operationalHealth,
      ] as unknown as EvaluatorT[],
      experimentPrefix: "recommendation-ranking",
      metadata: experimentMetadata(),
      maxConcurrency: 2,
    },
  );
  const hardConstraints = scoreForKey(results, "hard_constraint_compliance");
  const idValidity = scoreForKey(results, "recommendation_id_validity");
  recommendationReleaseGateFailed ||= hardConstraints < 1 || idValidity < 1;
  // A crashed or missing evaluator is a zero, never an invisible omission
  // that makes the remaining scores look better.
  const score = averageExpectedScores(results, evaluatorKeys);
  process.stdout.write(`\nRecommendation ranking complete — average ${score.toFixed(2)}, hard constraints ${hardConstraints.toFixed(2)}, ids ${idValidity.toFixed(2)}.\n`);
  return score;
}

async function runRecommendationReranking(): Promise<number> {
  const name = "award-travel-recommendation-reranking";
  await seedDataset(name, await loadJsonl("recommendation-reranking"));
  const results = await evaluate(
    async (input: Record<string, unknown>) => (
      await rerankingTarget(input as unknown as RerankingFixture)
    ) as unknown as Record<string, unknown>,
    {
      data: name,
      evaluators: [preferenceOnlyNoSearch, rerankPreferenceFit, operationalHealth] as unknown as EvaluatorT[],
      experimentPrefix: "recommendation-reranking",
      metadata: experimentMetadata(),
      // The provider factory is deliberately instrumented process-wide, so
      // serial execution prevents one example from observing another's counter.
      maxConcurrency: 1,
    },
  );
  const noSearch = scoreForKey(results, "preference_only_no_search");
  recommendationReleaseGateFailed ||= noSearch < 1;
  const score = averageExpectedScores(results, [
    "preference_only_no_search",
    "rerank_preference_fit",
    "operational_health",
  ]);
  process.stdout.write(`\nRecommendation reranking complete — average ${score.toFixed(2)}, no-search ${noSearch.toFixed(2)}.\n`);
  return score;
}

async function runIntentRouting(): Promise<number> {
  const name = "award-travel-intent-routing";
  const examples = await loadJsonl("intent-routing");
  await seedDataset(name, examples);

  const results = await evaluate(
    async (input: { question: string }) => {
      const out = await triage({
        messages: [new HumanMessage(input.question)],
      } as never);
      return { intent: out.intent };
    },
    {
      data: name,
      evaluators: [exactIntent],
      experimentPrefix: "intent-routing",
      metadata: experimentMetadata(),
    },
  );

  const score = averageScore(results);
  process.stdout.write(`\nIntent routing complete — average score ${score.toFixed(2)}. View in LangSmith.\n`);
  return score;
}

async function runSearchPlanning(): Promise<number> {
  const name = "award-travel-search-planning";
  await seedDataset(name, await loadJsonl("search-planning"));

  const results = await evaluate(
    async (input: { question: string; referenceDate: string }) => {
      // The frozen clock. Without it, "this summer" resolves against today and
      // the dataset silently starts failing in September.
      const out = await planSearch(
        { messages: [new HumanMessage(input.question)] } as never,
        new Date(`${input.referenceDate}T00:00:00Z`),
      );
      // planSearch returns a partial update — only the fields this turn's
      // message addressed. Route it through the real reducer with a null
      // starting state (these are all cold-start, single-turn scenarios) so
      // we compare the same fully-resolved plan the app actually produces.
      return applyUpdate(null, (out.searchPlan ?? {}) as Partial<SearchPlan>);
    },
    {
      data: name,
      evaluators: [planSimilarity],
      experimentPrefix: "search-planning",
      metadata: experimentMetadata(),
    },
  );

  const score = averageScore(results);
  process.stdout.write(`\nSearch planning complete — average score ${score.toFixed(2)}.\n`);
  return score;
}

async function runGroundedness(): Promise<number> {
  const name = "award-travel-groundedness";
  await seedDataset(name, await loadJsonl("groundedness"));

  // Forced, not inferred: evals must never depend on whether a developer
  // happens to have SEATS_AERO_API_KEY set in their environment. Without
  // this, "replay" was metadata-only — search_awards would still call the
  // live API whenever the key was present, consuming quota and returning
  // nondeterministic data despite the eval claiming mode: "replay" below.
  setSeatsAeroClientFactory(() => new ReplaySeatsAeroClient());

  // No checkpointer: each example is an independent turn.
  const graph = buildGraphWithoutCheckpointer();

  const results = await evaluate(
    async (input: { question: string }) => {
      const state = await graph.invoke({
        messages: [new HumanMessage(input.question)],
      });
      // Carry the whole state through so the deterministic check can compare
      // the draft against the exact tool results that produced it.
      return { draft: state.draft, state };
    },
    {
      data: name,
      evaluators: [hallucinationCheck, helpfulnessJudge],
      experimentPrefix: "groundedness",
      metadata: experimentMetadata(),
      // 1, not 2: the knowledge branch's retrieveKnowledge() embeds its query
      // via Voyage on every call, and this project's Voyage account (no
      // payment method on file) is capped at 3 requests/minute. At
      // concurrency 2, back-to-back knowledge-branch examples routinely hit
      // that cap; retrieve.ts's catch-and-degrade treats a 429 exactly like
      // an outage (kbDocs: [] , no hallucination, but a visibly worse
      // answer), which was observed directly in a live run of this eval.
      // Serializing does not eliminate the risk on a dataset with more
      // knowledge examples than this one, but it removes the self-inflicted
      // half of it.
      maxConcurrency: 1,
      // Only this stage repeats — it's the only one whose scoring depends on
      // a full LLM synthesis pass (intent/planning are also LLM calls, but
      // their evaluators check exact/structural match, which is far less
      // sensitive to sampling variance than the groundedness judge). Capped
      // at 2, not the usual 3, because each repetition multiplies the
      // knowledge-branch examples' Voyage calls against the same tight
      // 3-req/minute quota noted above — 3 repetitions at even this
      // concurrency risks the same self-inflicted 429s this comment already
      // warns about.
      numRepetitions: 2,
    },
  );

  const score = averageScore(results);
  process.stdout.write(`\nGroundedness eval complete — average score ${score.toFixed(2)}.\n`);
  return score;
}

async function main(): Promise<void> {
  const which = process.argv[2] ?? "all";
  const scores: Record<string, number> = {};
  if (which === "all" || which === "intent") scores["intent-routing"] = await runIntentRouting();
  if (which === "all" || which === "planning") scores["search-planning"] = await runSearchPlanning();
  if (which === "all" || which === "grounded") scores.groundedness = await runGroundedness();
  if (which === "all" || which === "recommendations" || which === "ranking") {
    scores["recommendation-ranking"] = await runRecommendationRanking();
  }
  if (which === "all" || which === "recommendations" || which === "reranking") {
    scores["recommendation-reranking"] = await runRecommendationReranking();
  }

  process.stdout.write("\n--- Summary ---\n");
  let anyBelowThreshold = recommendationReleaseGateFailed;
  for (const [stage, score] of Object.entries(scores)) {
    const threshold = THRESHOLDS[stage];
    const pass = score >= threshold;
    if (!pass) anyBelowThreshold = true;
    process.stdout.write(
      `${pass ? "PASS" : "FAIL"} ${stage}: ${score.toFixed(2)} (threshold ${threshold.toFixed(2)})\n`,
    );
  }
  if (anyBelowThreshold) {
    if (recommendationReleaseGateFailed) {
      process.stdout.write("\nRelease gate failed: hard constraints, id validity, and preference-only no-search must each be 100%.\n");
    }
    process.stdout.write("\nOne or more stages fell below its threshold.\n");
    process.exitCode = 1;
  }
}

// Only run when executed directly (`tsx evals/run.ts`), not when imported —
// run.test.ts imports contentHash for direct unit testing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

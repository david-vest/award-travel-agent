import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Client } from "langsmith";
import { evaluate } from "langsmith/evaluation";
import { HumanMessage } from "@langchain/core/messages";
import type { BaseChannel, BinaryOperatorAggregate } from "@langchain/langgraph";
import { triage } from "../src/agent/nodes/triage";
import { planSearch } from "../src/agent/nodes/plan-search";
import { setSeatsAeroClientFactory } from "../src/agent/nodes/search";
import { ReplaySeatsAeroClient } from "../src/tools/seats-aero/replay";
import { buildGraphWithoutCheckpointer } from "../src/agent/graph";
import { AgentState, type SearchPlan } from "../src/agent/state";
import { RECOMMENDATION_PIPELINE_VERSION } from "../src/domain/recommendation-preferences";
import { exactIntent } from "./evaluators/exact-intent";
import { planSimilarity } from "./evaluators/plan-similarity";
import { hallucinationCheck } from "./evaluators/hallucination";
import { helpfulnessJudge } from "./evaluators/helpfulness";

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
};

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
    ...(gitSha ? { gitSha } : {}),
  };
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

  process.stdout.write("\n--- Summary ---\n");
  let anyBelowThreshold = false;
  for (const [stage, score] of Object.entries(scores)) {
    const threshold = THRESHOLDS[stage];
    const pass = score >= threshold;
    if (!pass) anyBelowThreshold = true;
    process.stdout.write(
      `${pass ? "PASS" : "FAIL"} ${stage}: ${score.toFixed(2)} (threshold ${threshold.toFixed(2)})\n`,
    );
  }
  if (anyBelowThreshold) {
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

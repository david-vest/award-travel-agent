import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "langsmith";
import { evaluate } from "langsmith/evaluation";
import { HumanMessage } from "@langchain/core/messages";
import type { BaseChannel, BinaryOperatorAggregate } from "@langchain/langgraph";
import { triage } from "../src/agent/nodes/triage";
import { planSearch } from "../src/agent/nodes/plan-search";
import { buildGraphWithoutCheckpointer } from "../src/agent/graph";
import { AgentState, type SearchPlan } from "../src/agent/state";
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

/** Idempotent: creates the dataset on first run, reuses it thereafter. */
async function seedDataset(name: string, examples: Example[]): Promise<string> {
  const existing = client.listDatasets({ datasetName: name });
  for await (const ds of existing) {
    return ds.id;
  }

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

async function runIntentRouting(): Promise<void> {
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
      // Evals never touch the live API; replay keeps them reproducible.
      metadata: { mode: "replay" },
    },
  );

  process.stdout.write(`\nIntent routing complete. View in LangSmith.\n`);
  void results;
}

async function runSearchPlanning(): Promise<void> {
  const name = "award-travel-search-planning";
  await seedDataset(name, await loadJsonl("search-planning"));

  await evaluate(
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
      metadata: { mode: "replay" },
    },
  );

  process.stdout.write("\nSearch planning complete.\n");
}

async function runGroundedness(): Promise<void> {
  const name = "award-travel-groundedness";
  await seedDataset(name, await loadJsonl("groundedness"));

  // No checkpointer: each example is an independent turn.
  const graph = buildGraphWithoutCheckpointer();

  await evaluate(
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
      metadata: { mode: "replay" },
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
    },
  );

  process.stdout.write("\nGroundedness eval complete.\n");
}

async function main(): Promise<void> {
  const which = process.argv[2] ?? "all";
  if (which === "all" || which === "intent") await runIntentRouting();
  if (which === "all" || which === "planning") await runSearchPlanning();
  if (which === "all" || which === "grounded") await runGroundedness();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

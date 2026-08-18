import { z } from "zod";
import { chat } from "../../src/agent/models";
import { plainSystem } from "../../src/agent/cache";
import type { AgentStateType } from "../../src/agent/state";

const verdictSchema = z.object({
  answersQuestion: z.boolean(),
  namesProgram: z.boolean(),
  givesBookingPath: z.boolean(),
  citesSourceWhenRelevant: z.boolean(),
  reasoning: z.string(),
});

const JUDGE_PROMPT = `You grade answers from an award-travel assistant.

Judge only these four things, independently:
- answersQuestion: does it address what was actually asked?
- namesProgram: does it name at least one specific mileage program? (false is
  correct when no availability was found or the question was not about a redemption)
- givesBookingPath: does it tell the user what to do next?
- citesSourceWhenRelevant: when a fact from outside research materially
  informs the answer, does the answer cite a source in prose (a normal
  Markdown link, e.g. "According to Qatar's own product page, ...")? True is
  also correct when no outside research materially changed the answer — this
  is not asking whether a citation is present, but whether one is present
  when it should be. The answer must never cite a document id, a
  square-bracket reference, or say "knowledge base" — that would be a
  synthesis-prompt violation, not something to reward.

Do NOT judge accuracy of numbers — a separate deterministic check handles that.
Do NOT reward length. A correct short answer beats a padded one.`;

/** Case-insensitive; vacuously true when there's nothing to require. */
function mentionsAll(draft: string, mustMention: string[]): boolean {
  const lower = draft.toLowerCase();
  return mustMention.every((term) => lower.includes(term.toLowerCase()));
}

function matchesShouldFindOptions(state: AgentStateType | undefined, shouldFindOptions: boolean): boolean {
  const found = (state?.awardResults?.length ?? 0) > 0;
  return found === shouldFindOptions;
}

/**
 * The one place a judge belongs. "Is this helpful?" needs judgment; "is this
 * number real?" does not, and using a judge there would be strictly worse.
 * mustMention/shouldFindOptions are checked deterministically against the
 * dataset's own referenceOutputs rather than left to the judge's opinion —
 * a real, checkable expectation shouldn't be graded by asking an LLM to
 * eyeball it.
 */
export async function helpfulnessJudge(args: {
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  referenceOutputs?: Record<string, unknown>;
}): Promise<{ key: string; score: number; comment: string }> {
  // thinking:"adaptive" + withStructuredOutput's forced tool calling don't
  // always compose cleanly (see models.ts) — every other structured-output
  // call site in this codebase sets disableThinking for exactly this reason.
  const model = chat({ effort: "low", disableThinking: true }).withStructuredOutput(
    verdictSchema,
    { name: "helpfulness_verdict" },
  );

  const draft = String(args.outputs?.draft ?? "");
  const verdict = await model.invoke([
    plainSystem(JUDGE_PROMPT),
    {
      role: "user",
      content: `Question:\n${args.inputs?.question}\n\nAnswer:\n${draft}`,
    },
  ]);

  const criteria = [
    verdict.answersQuestion,
    verdict.namesProgram,
    verdict.givesBookingPath,
    verdict.citesSourceWhenRelevant,
    mentionsAll(draft, (args.referenceOutputs?.mustMention as string[] | undefined) ?? []),
  ];
  if (typeof args.referenceOutputs?.shouldFindOptions === "boolean") {
    criteria.push(
      matchesShouldFindOptions(
        args.outputs?.state as AgentStateType | undefined,
        args.referenceOutputs.shouldFindOptions,
      ),
    );
  }

  return {
    key: "helpfulness",
    score: criteria.filter(Boolean).length / criteria.length,
    comment: verdict.reasoning,
  };
}

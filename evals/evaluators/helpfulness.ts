import { z } from "zod";
import { chat } from "../../src/agent/models";
import { plainSystem } from "../../src/agent/cache";

const verdictSchema = z.object({
  answersQuestion: z.boolean(),
  namesProgram: z.boolean(),
  givesBookingPath: z.boolean(),
  citesKnowledge: z.boolean(),
  reasoning: z.string(),
});

const JUDGE_PROMPT = `You grade answers from an award-travel assistant.

Judge only these four things, independently:
- answersQuestion: does it address what was actually asked?
- namesProgram: does it name at least one specific mileage program? (false is
  correct when no availability was found or the question was not about a redemption)
- givesBookingPath: does it tell the user what to do next?
- citesKnowledge: does it cite a knowledge-base document as [some-id]?

Do NOT judge accuracy of numbers — a separate deterministic check handles that.
Do NOT reward length. A correct short answer beats a padded one.`;

/**
 * The one place a judge belongs. "Is this helpful?" needs judgment; "is this
 * number real?" does not, and using a judge there would be strictly worse.
 */
export async function helpfulnessJudge(args: {
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
}): Promise<{ key: string; score: number; comment: string }> {
  // thinking:"adaptive" + withStructuredOutput's forced tool calling don't
  // always compose cleanly (see models.ts) — every other structured-output
  // call site in this codebase sets disableThinking for exactly this reason.
  const model = chat({ effort: "low", disableThinking: true }).withStructuredOutput(
    verdictSchema,
    { name: "helpfulness_verdict" },
  );

  const verdict = await model.invoke([
    plainSystem(JUDGE_PROMPT),
    {
      role: "user",
      content: `Question:\n${args.inputs?.question}\n\nAnswer:\n${args.outputs?.draft}`,
    },
  ]);

  const criteria = [
    verdict.answersQuestion,
    verdict.namesProgram,
    verdict.givesBookingPath,
    verdict.citesKnowledge,
  ];

  return {
    key: "helpfulness",
    score: criteria.filter(Boolean).length / criteria.length,
    comment: verdict.reasoning,
  };
}

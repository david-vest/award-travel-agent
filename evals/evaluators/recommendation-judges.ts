import { z } from "zod";
import { chat } from "../../src/agent/models";
import { plainSystem } from "../../src/agent/cache";
import type {
  RecommendationEvalOutput,
  RecommendationExpected,
  RecommendationFixture,
} from "../recommendation-types";

type Args = {
  inputs: RecommendationFixture;
  outputs: RecommendationEvalOutput;
  referenceOutputs?: RecommendationExpected;
};

const pairwiseSchema = z.object({
  winner: z.enum(["deterministic_v1", "hybrid", "tie"]),
  reasoning: z.string().trim().min(1).max(1_200),
});

const explanationSchema = z.object({
  preferenceFit: z.boolean(),
  usefulTradeoff: z.boolean(),
  evidenceAligned: z.boolean(),
  concise: z.boolean(),
  reasoning: z.string().trim().min(1).max(1_200),
});

const PAIRWISE_PROMPT = `You compare two award-flight orderings against a traveler's stated SOFT preference.

Hard-constraint and factual correctness are evaluated separately in code. Judge only which ordering better honors the stated tradeoff among the supplied viable candidates. Do not assume cheapest is best unless the preference says so. Do not reward the hybrid merely because it is newer. Return tie when the preference does not justify a meaningful distinction. Keep reasoning to two concise sentences.`;

const EXPLANATION_PROMPT = `You judge an award-travel recommendation explanation.

Score only whether it (1) reflects the stated soft preference, (2) explains a decision-useful tradeoff, (3) stays aligned with the supplied candidate facts/evidence rationales, and (4) is concise. Internal evidence IDs are bookkeeping, not citations. A separate deterministic evaluator is the factual authority, so do not invent or infer missing facts. Keep reasoning to two concise sentences.`;

function judgeModel() {
  return chat({ model: "haiku", effort: "low", maxTokens: 700, disableThinking: true });
}

function compactCandidates(args: Args) {
  return args.inputs.awardResults.map((option) => {
    const id = `${option.availabilityId}:${option.cabin}`;
    const trip = args.inputs.tripSummaries.find((item) => item.availabilityId === option.availabilityId);
    return {
      id,
      miles: option.miles,
      taxes: trip?.totalTaxes ?? option.taxes ?? null,
      direct: option.direct,
      stops: trip?.stops ?? (option.direct ? 0 : null),
      durationMinutes: trip?.durationMinutes ?? null,
      assessments: args.inputs.candidateAssessments[id]?.dimensions ?? {},
    };
  });
}

export async function preferencePairwiseJudge(args: Args): Promise<{ key: string; score: number; comment: string }> {
  const verdict = await judgeModel().withStructuredOutput(pairwiseSchema, { name: "recommendation_pairwise_verdict" }).invoke([
    plainSystem(PAIRWISE_PROMPT),
    {
      role: "user",
      content: JSON.stringify({
        question: args.inputs.question,
        preference: args.inputs.recommendationPreferences,
        candidates: compactCandidates(args),
        deterministicV1Order: args.outputs.deterministicV1Order,
        hybridOrder: args.outputs.hybrid.map((item) => item.id),
      }),
    },
  ]);
  return {
    key: "preference_pairwise",
    score: verdict.winner === "hybrid" ? 1 : verdict.winner === "tie" ? 0.5 : 0,
    comment: `${verdict.winner}: ${verdict.reasoning}`,
  };
}

export async function explanationQualityJudge(args: Args): Promise<{ key: string; score: number; comment: string }> {
  const verdict = await judgeModel().withStructuredOutput(explanationSchema, { name: "recommendation_explanation_verdict" }).invoke([
    plainSystem(EXPLANATION_PROMPT),
    {
      role: "user",
      content: JSON.stringify({
        question: args.inputs.question,
        preference: args.inputs.recommendationPreferences,
        candidates: compactCandidates(args),
        recommendationOrder: args.outputs.hybrid.map((item) => ({ id: item.id, reason: item.reason })),
        explanation: args.outputs.draft,
      }),
    },
  ]);
  const criteria = [verdict.preferenceFit, verdict.usefulTradeoff, verdict.evidenceAligned, verdict.concise];
  return {
    key: "explanation_quality",
    score: criteria.filter(Boolean).length / criteria.length,
    comment: verdict.reasoning,
  };
}

import { z } from "zod";
import { plainSystem } from "../cache";
import { chat } from "../models";
import { ASSESS_CANDIDATES_PROMPT } from "../prompts/assess-candidates";
import type { AgentStateType } from "../state";
import { SCORING_DIMENSIONS, type ScoringDimension } from "../../rag/frontmatter";
import { optionId, type RetrievedDoc } from "../../rag/retriever";
import type {
  CandidateAssessment,
  CandidateAssessments,
} from "../../domain/candidate-assessment";

const dimensionAssessmentSchema = z.object({
  dimension: z.enum(SCORING_DIMENSIONS),
  score: z.number().int().min(0).max(100),
  evidenceIds: z.array(z.string().min(1)).min(1).max(4),
  rationale: z.string().trim().min(1).max(160),
});

export const candidateAssessmentOutputSchema = z.object({
  assessments: z.array(z.object({
    optionId: z.string().min(1),
    dimensions: z.array(dimensionAssessmentSchema).min(1).max(SCORING_DIMENSIONS.length),
  })).max(20),
});

type RawAssessments = z.infer<typeof candidateAssessmentOutputSchema>;

function fallbackAssessment(id: string): CandidateAssessment {
  return { optionId: id, dimensions: {}, confidence: "low" };
}

function evidenceConfidence(evidence: RetrievedDoc[]): CandidateAssessment["confidence"] {
  if (evidence.some((doc) => doc.match?.confidence === "high")) return "high";
  if (evidence.some((doc) => doc.match?.confidence === "medium")) return "medium";
  return "low";
}

/** Rejects partial, duplicated, or cross-option citations before ranking sees them. */
export function validateCandidateAssessments(
  raw: RawAssessments,
  evidenceByOption: Record<string, RetrievedDoc[]>,
): CandidateAssessments {
  const expectedIds = Object.entries(evidenceByOption)
    .filter(([, docs]) => docs.length > 0)
    .map(([id]) => id)
    .sort();
  const actualIds = raw.assessments.map((assessment) => assessment.optionId).sort();
  if (new Set(actualIds).size !== actualIds.length || actualIds.join("|") !== expectedIds.join("|")) {
    throw new Error("Candidate assessment cardinality or option IDs did not match the request");
  }

  return Object.fromEntries(raw.assessments.map((assessment) => {
    const evidence = evidenceByOption[assessment.optionId] ?? [];
    const evidenceById = new Map(evidence.map((doc) => [doc.id, doc]));
    const dimensions: CandidateAssessment["dimensions"] = {};
    for (const item of assessment.dimensions) {
      if (dimensions[item.dimension]) throw new Error(`Duplicate ${item.dimension} assessment`);
      for (const evidenceId of item.evidenceIds) {
        const doc = evidenceById.get(evidenceId);
        if (!doc || !(doc.dimensions ?? []).includes(item.dimension)) {
          throw new Error(`Invalid evidence ${evidenceId} for ${item.dimension}`);
        }
      }
      dimensions[item.dimension] = {
        score: item.score,
        evidenceIds: [...new Set(item.evidenceIds)],
        rationale: item.rationale,
      };
    }
    return [assessment.optionId, {
      optionId: assessment.optionId,
      dimensions,
      confidence: evidenceConfidence(evidence),
    } satisfies CandidateAssessment];
  }));
}

function assessmentInput(evidenceByOption: Record<string, RetrievedDoc[]>): string {
  return JSON.stringify({
    options: Object.entries(evidenceByOption)
      .filter(([, docs]) => docs.length > 0)
      .map(([id, docs]) => ({
        optionId: id,
        evidence: docs.map((doc) => ({
          evidenceId: doc.id,
          dimensions: doc.dimensions ?? [],
          productName: doc.productName,
          excerpt: doc.text.slice(0, 900),
          updated: doc.updated,
          reviewAfter: doc.reviewAfter,
          matchConfidence: doc.match?.confidence ?? "low",
          matchReasons: doc.match?.reasons ?? [],
          sources: doc.sources,
        })),
      })),
  });
}

export async function assessCandidateExperience(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const options = state.candidateShortlist === undefined
    ? state.awardResults ?? []
    : state.candidateShortlist;
  const evidenceByOption = Object.fromEntries(options.map((option) => {
    const id = optionId(option);
    return [id, state.optionEvidence?.[id] ?? []];
  }));
  const candidatesWithEvidence = options.filter((option) =>
    (evidenceByOption[optionId(option)]?.length ?? 0) > 0);
  const fallbacks = Object.fromEntries(options.map((option) => {
    const id = optionId(option);
    return [id, fallbackAssessment(id)];
  }));
  if (candidatesWithEvidence.length === 0) return { candidateAssessments: fallbacks };

  try {
    const model = chat({
      model: "haiku",
      effort: "low",
      maxTokens: 2_500,
      disableThinking: true,
    }).withStructuredOutput(candidateAssessmentOutputSchema, { name: "candidate_experience_assessments" });
    const raw = candidateAssessmentOutputSchema.parse(await model.invoke([
      plainSystem(ASSESS_CANDIDATES_PROMPT),
      { role: "user", content: assessmentInput(evidenceByOption) },
    ]));
    return {
      candidateAssessments: {
        ...fallbacks,
        ...validateCandidateAssessments(raw, evidenceByOption),
      },
    };
  } catch {
    return {
      candidateAssessments: fallbacks,
      degradedReasons: [...(state.degradedReasons ?? []), "candidate_assessment_failed"],
    };
  }
}

export function assessmentDimensions(
  assessment: CandidateAssessment | undefined,
): Array<[ScoringDimension, number]> {
  if (!assessment) return [];
  return Object.entries(assessment.dimensions)
    .filter((entry): entry is [ScoringDimension, NonNullable<typeof entry[1]>] => Boolean(entry[1]))
    .map(([dimension, detail]) => [dimension, detail.score]);
}

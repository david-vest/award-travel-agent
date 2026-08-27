import { z } from "zod";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
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

export const CANDIDATE_ASSESSMENT_BATCH_SIZE = 5;
export const CANDIDATE_ASSESSMENT_CONCURRENCY = 2;
export const CANDIDATE_RATIONALE_MAX_CHARS = 160;

const dimensionAssessmentSchema = z.object({
  dimension: z.enum(SCORING_DIMENSIONS),
  score: z.number().int().min(0).max(100),
  evidenceIds: z.array(z.string().min(1)).min(1).max(4),
  rationale: z.string().trim().min(1),
});

export const candidateAssessmentOutputSchema = z.object({
  assessments: z.array(z.object({
    optionId: z.string().min(1),
    dimensions: z.array(dimensionAssessmentSchema).min(1).max(SCORING_DIMENSIONS.length),
  })).max(CANDIDATE_ASSESSMENT_BATCH_SIZE),
});

type RawAssessments = z.infer<typeof candidateAssessmentOutputSchema>;

const confidenceOrder = { high: 0, medium: 1, low: 2 } as const;

function fallbackAssessment(id: string): CandidateAssessment {
  return { optionId: id, dimensions: {}, confidence: "low" };
}

function evidenceConfidence(evidence: RetrievedDoc[]): CandidateAssessment["confidence"] {
  if (evidence.some((doc) => doc.match?.confidence === "high")) return "high";
  if (evidence.some((doc) => doc.match?.confidence === "medium")) return "medium";
  return "low";
}

function normalizeRationale(rationale: string): string {
  const trimmed = rationale.trim();
  if (trimmed.length <= CANDIDATE_RATIONALE_MAX_CHARS) return trimmed;

  const available = trimmed.slice(0, CANDIDATE_RATIONALE_MAX_CHARS - 1);
  const lastWordBoundary = available.lastIndexOf(" ");
  const cutoff = lastWordBoundary >= CANDIDATE_RATIONALE_MAX_CHARS * 0.75
    ? lastWordBoundary
    : available.length;
  return `${available.slice(0, cutoff).replace(/[,:;\s]+$/u, "")}…`;
}

function evidenceStrength(a: RetrievedDoc, b: RetrievedDoc): number {
  const aConfidence = a.match?.confidence ?? "low";
  const bConfidence = b.match?.confidence ?? "low";
  const aUpdated = Date.parse(a.updated);
  const bUpdated = Date.parse(b.updated);
  return confidenceOrder[aConfidence] - confidenceOrder[bConfidence]
    || Number(Boolean(a.match?.stale)) - Number(Boolean(b.match?.stale))
    || Number(Boolean(a.match?.semanticSupplement)) - Number(Boolean(b.match?.semanticSupplement))
    || (Number.isFinite(bUpdated) ? bUpdated : 0) - (Number.isFinite(aUpdated) ? aUpdated : 0)
    || a.id.localeCompare(b.id);
}

/** Keeps one strongest applicable document per dimension, deduplicating documents selected more than once. */
export function strongestEvidencePerDimension(evidence: RetrievedDoc[]): RetrievedDoc[] {
  const selected = new Map<string, { doc: RetrievedDoc; dimensions: Set<ScoringDimension> }>();
  for (const dimension of SCORING_DIMENSIONS) {
    const strongest = evidence
      .filter((doc) => (doc.dimensions ?? []).includes(dimension))
      .sort(evidenceStrength)[0];
    if (!strongest) continue;
    const current = selected.get(strongest.id) ?? { doc: strongest, dimensions: new Set<ScoringDimension>() };
    current.dimensions.add(dimension);
    selected.set(strongest.id, current);
  }
  return [...selected.values()]
    .sort((a, b) => evidenceStrength(a.doc, b.doc))
    .map(({ doc, dimensions }) => ({ ...doc, dimensions: [...dimensions] }));
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
        rationale: normalizeRationale(item.rationale),
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
        })),
      })),
  });
}

function assessmentBatches(
  evidenceByOption: Record<string, RetrievedDoc[]>,
): Array<Record<string, RetrievedDoc[]>> {
  const entries = Object.entries(evidenceByOption).filter(([, docs]) => docs.length > 0);
  const batches: Array<Record<string, RetrievedDoc[]>> = [];
  for (let index = 0; index < entries.length; index += CANDIDATE_ASSESSMENT_BATCH_SIZE) {
    batches.push(Object.fromEntries(entries.slice(index, index + CANDIDATE_ASSESSMENT_BATCH_SIZE)));
  }
  return batches;
}

async function assessBatch(
  model: { invoke: (messages: BaseLanguageModelInput) => Promise<unknown> },
  evidenceByOption: Record<string, RetrievedDoc[]>,
): Promise<CandidateAssessments> {
  const raw = candidateAssessmentOutputSchema.parse(await model.invoke([
    plainSystem(ASSESS_CANDIDATES_PROMPT),
    { role: "user", content: assessmentInput(evidenceByOption) },
  ]));
  return validateCandidateAssessments(raw, evidenceByOption);
}

export async function assessCandidateExperience(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const options = state.candidateShortlist === undefined
    ? state.awardResults ?? []
    : state.candidateShortlist;
  const evidenceByOption = Object.fromEntries(options.map((option) => {
    const id = optionId(option);
    return [id, strongestEvidencePerDimension(state.optionEvidence?.[id] ?? [])];
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
    const batches = assessmentBatches(evidenceByOption);
    const batchResults: Array<PromiseSettledResult<CandidateAssessments>> = [];
    for (let index = 0; index < batches.length; index += CANDIDATE_ASSESSMENT_CONCURRENCY) {
      batchResults.push(...await Promise.allSettled(
        batches
          .slice(index, index + CANDIDATE_ASSESSMENT_CONCURRENCY)
          .map((batch) => assessBatch(model, batch)),
      ));
    }
    const successful = batchResults.flatMap((result) =>
      result.status === "fulfilled" ? Object.entries(result.value) : []);
    const failed = batchResults.some((result) => result.status === "rejected");
    return {
      candidateAssessments: {
        ...fallbacks,
        ...Object.fromEntries(successful),
      },
      ...(failed ? {
        degradedReasons: [...new Set([...(state.degradedReasons ?? []), "candidate_assessment_failed"])],
      } : {}),
    };
  } catch {
    return {
      candidateAssessments: fallbacks,
      degradedReasons: [...new Set([...(state.degradedReasons ?? []), "candidate_assessment_failed"])],
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

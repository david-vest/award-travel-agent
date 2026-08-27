import type { ScoringDimension } from "../rag/frontmatter";

export type DimensionAssessment = {
  score: number;
  evidenceIds: string[];
  rationale: string;
};

export type CandidateAssessment = {
  optionId: string;
  dimensions: Partial<Record<ScoringDimension, DimensionAssessment>>;
  confidence: "high" | "medium" | "low";
};

export type CandidateAssessments = Record<string, CandidateAssessment>;

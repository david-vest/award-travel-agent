import { z } from "zod";
import { AWARD_PROGRAMS, CREDIT_CARD_PROGRAMS, type AwardProgramId, type CreditCardProgramId } from "../domain/programs";
import {
  RANKING_EXPERIENCE_WEIGHTS,
  RANKING_PRIORITY_VALUES,
  type RankingPreference,
} from "../domain/recommendation-preferences";

export const CABIN_VALUES = ["economy", "premium", "business", "first"] as const;
export const STOP_PREFERENCES = ["nonstop", "up_to_one", "any"] as const;

const AWARD_PROGRAM_IDS = AWARD_PROGRAMS.map((p) => p.id) as [AwardProgramId, ...AwardProgramId[]];
const CREDIT_CARD_PROGRAM_IDS = CREDIT_CARD_PROGRAMS.map((p) => p.id) as [CreditCardProgramId, ...CreditCardProgramId[]];

export const rankingPreferenceSchema = z.object({
  experienceWeight: z.number().int().refine(
    (value) => RANKING_EXPERIENCE_WEIGHTS.some((weight) => weight === value),
    { message: "Experience weight must be 0, 25, 50, 75, or 100." },
  ),
  priorities: z.array(z.enum(RANKING_PRIORITY_VALUES)).max(RANKING_PRIORITY_VALUES.length).default([]),
});

const tripLocationSchema = z.object({
  code: z.string().trim().min(1).max(100),
  airports: z.array(z.string().length(3)).max(20).default([]),
  /** True only for a free-form place the advisor explicitly asks Roam to resolve. */
  custom: z.boolean().default(false),
});

/** Rejects a syntactically-shaped but non-existent date, e.g. 2026-02-30. */
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}, { message: "Must be a real calendar date." });

export const tripRequestSchema = z.object({
  origin: tripLocationSchema,
  destinations: z.array(tripLocationSchema).min(1).max(20),
  startDate: calendarDate,
  endDate: calendarDate,
  flexDays: z.number().int().min(0).max(14),
  cabins: z.array(z.enum(CABIN_VALUES)).min(1),
  travelers: z.number().int().min(1).max(9),
  stopPreference: z.enum(STOP_PREFERENCES),
  preferredAirlines: z.array(z.string().min(2).max(3)).max(20).default([]),
  creditCardPrograms: z.array(z.enum(CREDIT_CARD_PROGRAM_IDS)).max(10).default([]),
  awardPrograms: z.array(z.enum(AWARD_PROGRAM_IDS)).max(20).default([]),
  pointBalances: z.object({
    creditCards: z.record(z.string(), z.number().int().nonnegative()).default({}),
    awardPrograms: z.record(z.string(), z.number().int().nonnegative()).default({}),
  }).default({ creditCards: {}, awardPrograms: {} }),
  /** Per-traveler cash ceiling. Seats.aero's max_fees parameter uses USD cents. */
  maxTaxesFeesUsd: z.number().nonnegative().max(100_000).optional(),
  /** Soft recommendation weighting. Search eligibility remains governed by the fields above. */
  rankingPreference: rankingPreferenceSchema.optional(),
  notes: z.string().trim().max(1_000).optional(),
}).superRefine((value, ctx) => {
  if (value.endDate < value.startDate) {
    ctx.addIssue({ code: "custom", path: ["endDate"], message: "endDate must not be before startDate." });
  }
});

export type TripRequest = z.infer<typeof tripRequestSchema>;
export type { RankingPreference };

export const CLARIFICATION_CHOICE_IDS = [
  "allow_one_stop",
  "try_premium_economy",
  "keep_constraints",
] as const;

export type ClarificationChoiceId = (typeof CLARIFICATION_CHOICE_IDS)[number];

export type ClarificationRequest = {
  id: string;
  prompt: string;
  choices: Array<{
    id: ClarificationChoiceId;
    label: string;
    description: string;
  }>;
};

export const clarificationResumeSchema = z.object({
  choiceId: z.enum(CLARIFICATION_CHOICE_IDS),
});

export const agentRunRequestSchema = z.object({
  threadId: z.string().uuid().optional(),
  request: tripRequestSchema.optional(),
  message: z.string().trim().min(1).max(2_000).optional(),
  resume: clarificationResumeSchema.optional(),
}).superRefine((value, ctx) => {
  const inputCount = Number(Boolean(value.request)) + Number(Boolean(value.message)) + Number(Boolean(value.resume));
  if (inputCount === 0) {
    ctx.addIssue({ code: "custom", message: "A trip request, follow-up message, or clarification response is required." });
  }
  if (inputCount > 1) {
    ctx.addIssue({ code: "custom", message: "Provide only one run input at a time." });
  }
  if (value.resume && !value.threadId) {
    ctx.addIssue({ code: "custom", path: ["threadId"], message: "A thread ID is required to resume a clarification." });
  }
});

export type AgentRunRequest = z.infer<typeof agentRunRequestSchema>;

export type RecommendationConfidence = "high" | "medium" | "low";
export type RecommendationBadge = "best_overall" | "best_value" | "best_experience" | "best_schedule";

export type FlightRecommendation = {
  id: string;
  rank: number;
  origin: string;
  destination: string;
  date: string;
  cabin: string;
  miles: number;
  taxes?: { amount: number; currency: string };
  program: { id: string; label: string };
  carriers: string[];
  direct: boolean;
  stops?: number;
  connections?: Array<{ airport: string; layoverMinutes?: number }>;
  remainingSeats?: number;
  departsAt?: string;
  arrivesAt?: string;
  durationMinutes?: number;
  flightNumbers: string[];
  aircraft: string[];
  refreshedAt?: string;
  reason: string;
  scoreFactors: Array<{ label: string; value: string }>;
  confidence: RecommendationConfidence;
  valueScore?: number;
  experienceScore?: number;
  overallScore?: number;
  assessmentConfidence?: RecommendationConfidence;
  evidenceIds?: string[];
  qualitativeAssessments?: Partial<Record<"cabin_product" | "booking_ease" | "transfer_risk" | "connection_quality", {
    score: number;
    rationale: string;
    evidenceIds: string[];
  }>>;
  badges?: RecommendationBadge[];
  tradeoff?: {
    comparedWithId: string;
    extraMiles: number;
    feeDifferenceUsd?: number;
    durationSavedMinutes?: number;
    stopsSaved?: number;
  };
  positioning?: {
    tier: "destination_gateway" | "country_pair" | "region_pair";
    before?: string;
    after?: string;
    explanation: string;
  };
};

export type AgentStage = "search" | "rules" | "rank";
export type AgentEvent =
  | { type: "run_started"; threadId: string; runId: string }
  | { type: "stage"; stage: AgentStage; status: "active" | "complete"; detail?: string; elapsedMs?: number }
  | { type: "results"; recommendations: FlightRecommendation[] }
  | { type: "answer_delta"; text: string }
  | { type: "clarification_required"; clarification: ClarificationRequest }
  | { type: "complete"; answer: string; recommendations?: FlightRecommendation[]; searchRan?: boolean; refreshedAt?: string }
  | { type: "error"; code: string; message: string; retryable: boolean };

export const agentFeedbackSchema = z.object({
  runId: z.string().uuid(),
  kind: z.enum(["rating", "selected_option"]),
  rating: z.enum(["up", "down"]).optional(),
  selectedOptionId: z.string().trim().min(1).max(200).optional(),
  rankingVersion: z.string().trim().min(1).max(100),
  preferenceProfile: rankingPreferenceSchema,
  candidateIds: z.array(z.string().trim().min(1).max(200)).max(20),
  evidenceIds: z.array(z.string().trim().min(1).max(200)).max(100),
}).superRefine((value, ctx) => {
  if (value.kind === "rating" && !value.rating) {
    ctx.addIssue({ code: "custom", path: ["rating"], message: "A rating is required." });
  }
  if (value.kind === "selected_option" && !value.selectedOptionId) {
    ctx.addIssue({ code: "custom", path: ["selectedOptionId"], message: "A selected option is required." });
  }
});

export type AgentFeedback = z.infer<typeof agentFeedbackSchema>;

import { z } from "zod";
import { AWARD_PROGRAMS, CREDIT_CARD_PROGRAMS, type AwardProgramId, type CreditCardProgramId } from "../domain/programs";

export const CABIN_VALUES = ["economy", "premium", "business", "first"] as const;
export const STOP_PREFERENCES = ["nonstop", "up_to_one", "any"] as const;

const AWARD_PROGRAM_IDS = AWARD_PROGRAMS.map((p) => p.id) as [AwardProgramId, ...AwardProgramId[]];
const CREDIT_CARD_PROGRAM_IDS = CREDIT_CARD_PROGRAMS.map((p) => p.id) as [CreditCardProgramId, ...CreditCardProgramId[]];

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
  notes: z.string().trim().max(1_000).optional(),
}).superRefine((value, ctx) => {
  if (value.endDate < value.startDate) {
    ctx.addIssue({ code: "custom", path: ["endDate"], message: "endDate must not be before startDate." });
  }
});

export type TripRequest = z.infer<typeof tripRequestSchema>;

export const agentRunRequestSchema = z.object({
  threadId: z.string().uuid().optional(),
  request: tripRequestSchema.optional(),
  message: z.string().trim().min(1).max(2_000).optional(),
}).superRefine((value, ctx) => {
  if (!value.request && !value.message) {
    ctx.addIssue({ code: "custom", message: "A trip request or follow-up message is required." });
  }
  if (value.request && value.message) {
    ctx.addIssue({ code: "custom", message: "Provide either a structured trip request or a follow-up message, not both." });
  }
});

export type AgentRunRequest = z.infer<typeof agentRunRequestSchema>;

export type RecommendationConfidence = "high" | "medium" | "low";

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
  positioning?: {
    tier: "destination_gateway" | "country_pair" | "region_pair";
    before?: string;
    after?: string;
    explanation: string;
  };
};

export type AgentStage = "search" | "rules" | "rank";
export type AgentEvent =
  | { type: "run_started"; threadId: string }
  | { type: "stage"; stage: AgentStage; status: "active" | "complete"; detail?: string; elapsedMs?: number }
  | { type: "results"; recommendations: FlightRecommendation[] }
  | { type: "answer_delta"; text: string }
  | { type: "complete"; answer: string; recommendations?: FlightRecommendation[]; searchRan?: boolean; refreshedAt?: string }
  | { type: "error"; code: string; message: string; retryable: boolean };

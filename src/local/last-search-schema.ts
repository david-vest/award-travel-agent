import { z } from "zod";
import type { FlightRecommendation } from "../contracts/travel-search";
import {
  RANKING_EXPERIENCE_WEIGHTS,
  RANKING_PRIORITY_VALUES,
  type RankingPreference,
} from "../domain/recommendation-preferences";
import type {
  StoredAgentRun,
  StoredChatMessage,
  StoredLocation,
  StoredSearchForm,
} from "./last-search";

type StoredSearchFormInput = Omit<StoredSearchForm, "rankingPreference"> & {
  rankingPreference?: RankingPreference;
};

const LOCATION_KINDS = ["airport", "city", "group", "custom"] as const;
const CABINS = ["economy", "premium", "business", "first"] as const;
const STOP_FILTERS = ["nonstop", "one", "any"] as const;
const RUN_STATUSES = ["complete", "error"] as const;
const STAGE_STATUSES = ["waiting", "active", "complete"] as const;
const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
const RECOMMENDATION_BADGES = ["best_overall", "best_value", "best_experience", "best_schedule"] as const;
const POSITIONING_TIERS = ["destination_gateway", "country_pair", "region_pair"] as const;

const finiteNumber = z.number().finite();
const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const stringArray = z.array(z.string());
const stringRecord = z.record(z.string(), z.string());

const storedLocationSchema: z.ZodType<StoredLocation> = z.object({
  kind: z.enum(LOCATION_KINDS),
  code: z.string(),
  city: z.string(),
  country: z.string(),
  airports: stringArray,
}).passthrough();

const rankingPreferenceSchema: z.ZodType<RankingPreference> = z.object({
  experienceWeight: z.number().int().refine(
    (weight) => RANKING_EXPERIENCE_WEIGHTS.some((allowedWeight) => allowedWeight === weight),
    "Unsupported ranking weight",
  ),
  priorities: z.array(z.enum(RANKING_PRIORITY_VALUES))
    .max(RANKING_PRIORITY_VALUES.length)
    .refine((priorities) => new Set(priorities).size === priorities.length, "Ranking priorities must be unique"),
}).passthrough();

const storedSearchFormSchema: z.ZodType<StoredSearchFormInput> = z.object({
  origin: storedLocationSchema,
  destinations: z.array(storedLocationSchema).min(1),
  startDate: dateKey,
  endDate: dateKey,
  flexDays: z.number().int().min(0).max(14),
  cabins: z.array(z.enum(CABINS)).min(1),
  travelers: z.string(),
  selectedCreditPrograms: stringArray,
  selectedAwardPrograms: stringArray,
  creditCardBalances: stringRecord,
  awardProgramBalances: stringRecord,
  maxFees: z.string(),
  stops: z.enum(STOP_FILTERS),
  preferredAirlines: stringArray,
  rankingPreference: rankingPreferenceSchema.optional(),
  notes: z.string(),
}).passthrough();

const connectionSchema = z.object({
  airport: z.string(),
  layoverMinutes: finiteNumber.optional(),
}).passthrough();

const scoreFactorSchema = z.object({
  label: z.string(),
  value: z.string(),
}).passthrough();

const qualitativeAssessmentSchema = z.object({
  score: finiteNumber,
  rationale: z.string(),
  evidenceIds: stringArray,
}).passthrough();

const qualitativeAssessmentsSchema = z.object({
  cabin_product: qualitativeAssessmentSchema.optional(),
  booking_ease: qualitativeAssessmentSchema.optional(),
  transfer_risk: qualitativeAssessmentSchema.optional(),
  connection_quality: qualitativeAssessmentSchema.optional(),
}).strict();

const tradeoffSchema = z.object({
  comparedWithId: z.string(),
  extraMiles: finiteNumber,
  feeDifferenceUsd: finiteNumber.optional(),
  durationSavedMinutes: finiteNumber.optional(),
  stopsSaved: finiteNumber.optional(),
}).passthrough();

const positioningSchema = z.object({
  tier: z.enum(POSITIONING_TIERS),
  before: z.string().optional(),
  after: z.string().optional(),
  explanation: z.string(),
}).passthrough();

const flightRecommendationSchema: z.ZodType<FlightRecommendation> = z.object({
  id: z.string(),
  rank: finiteNumber,
  origin: z.string(),
  destination: z.string(),
  date: z.string(),
  cabin: z.string(),
  miles: finiteNumber,
  taxes: z.object({ amount: finiteNumber, currency: z.string() }).passthrough().optional(),
  program: z.object({ id: z.string(), label: z.string() }).passthrough(),
  carriers: stringArray,
  direct: z.boolean(),
  stops: finiteNumber.optional(),
  connections: z.array(connectionSchema).optional(),
  remainingSeats: finiteNumber.optional(),
  departsAt: z.string().optional(),
  arrivesAt: z.string().optional(),
  durationMinutes: finiteNumber.optional(),
  flightNumbers: stringArray,
  aircraft: stringArray,
  refreshedAt: z.string().optional(),
  reason: z.string(),
  scoreFactors: z.array(scoreFactorSchema),
  confidence: z.enum(CONFIDENCE_LEVELS),
  valueScore: finiteNumber.optional(),
  experienceScore: finiteNumber.optional(),
  overallScore: finiteNumber.optional(),
  assessmentConfidence: z.enum(CONFIDENCE_LEVELS).optional(),
  evidenceIds: stringArray.optional(),
  qualitativeAssessments: qualitativeAssessmentsSchema.optional(),
  badges: z.array(z.enum(RECOMMENDATION_BADGES)).optional(),
  tradeoff: tradeoffSchema.optional(),
  positioning: positioningSchema.optional(),
}).passthrough();

const stageStatesSchema = z.object({
  search: z.enum(STAGE_STATUSES),
  rules: z.enum(STAGE_STATUSES),
  rank: z.enum(STAGE_STATUSES),
}).passthrough();

const stageDetailsSchema = z.object({
  search: z.string(),
  rules: z.string(),
  rank: z.string(),
}).passthrough();

const storedAgentRunSchema: z.ZodType<StoredAgentRun> = z.object({
  status: z.enum(RUN_STATUSES),
  stages: stageStatesSchema,
  stageDetails: stageDetailsSchema,
  stageDurations: z.record(z.string(), finiteNumber),
  recommendations: z.array(flightRecommendationSchema),
  answer: z.string(),
  error: z.string().nullable(),
  threadId: z.string().nullable(),
}).passthrough();

const storedChatMessageSchema: z.ZodType<StoredChatMessage> = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
}).passthrough();

export const lastSearchSnapshotSchema = z.object({
  version: z.literal(1),
  savedAt: z.string(),
  form: storedSearchFormSchema,
  run: storedAgentRunSchema.nullable(),
  chatMessages: z.array(storedChatMessageSchema).optional(),
}).passthrough();

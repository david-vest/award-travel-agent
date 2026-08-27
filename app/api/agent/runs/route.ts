import { HumanMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { agentRunRequestSchema, type AgentEvent, type AgentStage, type FlightRecommendation } from "../../../../src/contracts/travel-search";
import { describeTripRequest } from "../../../../src/agent/nodes/prepare-ui-search";
import { getAgentGraph } from "../../../../src/agent/runtime";
import { checkRateLimit } from "../../../../src/api/rate-limit";
import {
  CANDIDATE_SHORTLIST_VERSION,
  PREFERENCE_INTERPRETER_VERSION,
  RECOMMENDATION_PIPELINE_VERSION,
  defaultRankingPreference,
} from "../../../../src/domain/recommendation-preferences";

export const runtime = "nodejs";

const encoder = new TextEncoder();

// No authentication in this app (a deliberate scope decision), so this is
// per-IP, not per-account — see rate-limit.ts's own module comment for the
// per-process-instance caveat.
const RATE_LIMIT = { limit: 10, windowMs: 60_000 };

// The largest legitimate TripRequest payload after the bounded arrays/string
// lengths in contracts/travel-search.ts is small — this is generous
// headroom, not a tight fit. A client that lies about or omits
// Content-Length isn't fully covered by this check alone; it's defense in
// depth alongside the Zod bounds, which are enforced either way.
const MAX_BODY_BYTES = 32 * 1024;
// Backstop for the whole request, not any single provider call — those are
// already bounded individually (POLL_CEILING_MS, live.ts's
// AbortSignal.timeout). This exists for the case where something upstream
// hangs past all of its own internal bounds.
const EXECUTION_DEADLINE_MS = 120_000;

function clientKey(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function eventPayload(event: AgentEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(request: Request) {
  const rateLimit = checkRateLimit(clientKey(request), RATE_LIMIT);
  if (!rateLimit.allowed) {
    return Response.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: { "Retry-After": Math.ceil(rateLimit.retryAfterMs / 1000).toString() } },
    );
  }

  const contentType = request.headers.get("content-type");
  if (!contentType || !/^application\/json(;|$)/i.test(contentType)) {
    return Response.json({ error: "Content-Type must be application/json." }, { status: 415 });
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return Response.json({ error: "Request body too large." }, { status: 413 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON request body." }, { status: 400 });
  }

  const parsed = agentRunRequestSchema.safeParse(json);
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });

  const body = parsed.data;
  const threadId = body.threadId ?? crypto.randomUUID();
  const message = body.message ?? (body.request ? describeTripRequest(body.request) : "");
  const rankingPreference = body.request
    ? body.request.rankingPreference ?? defaultRankingPreference()
    : undefined;
  const graph = await getAgentGraph();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: AgentEvent) => controller.enqueue(eventPayload(event));
      let recommendations: FlightRecommendation[] = [];
      let answer = "";
      let searchExecuted = Boolean(body.request);
      const stageStartedAt = new Map<AgentStage, number>();
      const stageStatus = new Map<AgentStage, "active" | "complete">();

      const activateStage = (stage: AgentStage, detail: string) => {
        if (stageStatus.get(stage) !== "active") stageStartedAt.set(stage, Date.now());
        stageStatus.set(stage, "active");
        send({ type: "stage", stage, status: "active", detail });
      };
      const completeStage = (stage: AgentStage, detail: string) => {
        const startedAt = stageStartedAt.get(stage) ?? Date.now();
        stageStatus.set(stage, "complete");
        send({ type: "stage", stage, status: "complete", detail, elapsedMs: Math.max(0, Date.now() - startedAt) });
      };

      const deadlineSignal = AbortSignal.any([request.signal, AbortSignal.timeout(EXECUTION_DEADLINE_MS)]);

      try {
        send({ type: "run_started", threadId });
        activateStage("search", body.request ? "Preparing the exact-route award query." : "Reading the follow-up and deciding whether a new search is needed.");

        const graphConfig: RunnableConfig = {
          configurable: { thread_id: threadId },
          metadata: {
            ui_version: "roam-search-v2",
            request_type: body.request ? "structured_search" : "follow_up",
            ranking_version: RECOMMENDATION_PIPELINE_VERSION,
            preference_interpreter_version: PREFERENCE_INTERPRETER_VERSION,
            candidate_shortlist_version: CANDIDATE_SHORTLIST_VERSION,
            credit_programs: body.request?.creditCardPrograms ?? [],
            award_programs: body.request?.awardPrograms ?? [],
            ...(rankingPreference ? {
              ranking_experience_weight: rankingPreference.experienceWeight,
              ranking_priorities: rankingPreference.priorities,
            } : {}),
          },
          tags: ["roam-ui"],
          signal: deadlineSignal,
        };
        const graphStream = await graph.stream(
          {
            messages: [new HumanMessage(message)],
            tripRequest: body.request ?? null,
          },
          { ...graphConfig, streamMode: "updates" },
        );

        for await (const update of graphStream as AsyncIterable<Record<string, Record<string, unknown>>>) {
          if (deadlineSignal.aborted) break;
          for (const [node, data] of Object.entries(update)) {
            // Surfaces a dependency degrading (e.g. refresh outage, RAG
            // retrieval failure) so the UI/trace can distinguish "nothing
            // was wrong" from "this answer is degraded" — additive to
            // whichever stage is currently active, not a new event type.
            if (Array.isArray(data.degradedReasons) && data.degradedReasons.length > 0) {
              const activeStage = [...stageStatus.entries()].find(([, status]) => status === "active")?.[0];
              if (activeStage) {
                send({
                  type: "stage",
                  stage: activeStage,
                  status: "active",
                  detail: `Degraded: ${(data.degradedReasons as string[]).join(", ")}`,
                });
              }
            }
            if (node === "resolve_ui_locations") {
              activateStage("search", "Resolved the requested places to searchable commercial airports.");
            }
            if (node === "interpret_preferences") {
              const preference = data.recommendationPreferences as { experienceWeight?: number; priorities?: string[]; rationale?: string } | undefined;
              const priorityCount = preference?.priorities?.length ?? 0;
              activateStage("search", `Interpreted the ranking brief at ${preference?.experienceWeight ?? 50}/100 toward journey experience${priorityCount ? ` with ${priorityCount} stated priorit${priorityCount === 1 ? "y" : "ies"}` : ""}.`);
            }
            if (node === "search_awards") {
              searchExecuted = true;
              const optionCount = Array.isArray(data.awardResults) ? data.awardResults.length : 0;
              completeStage("search", `The exact-route search returned ${optionCount.toLocaleString()} award option${optionCount === 1 ? "" : "s"}.`);
              activateStage("rules", "Checking itinerary details and whether a broader gateway search is worthwhile.");
            }
            if (node === "search_positioning") {
              searchExecuted = true;
              const attempts = Array.isArray(data.searchAttempts) ? data.searchAttempts.length : 0;
              const optionCount = Array.isArray(data.awardResults) ? data.awardResults.length : 0;
              activateStage("rules", `Expanded to ${attempts || "additional"} route scope${attempts === 1 ? "" : "s"}; validating ${optionCount.toLocaleString()} candidate options.`);
            }
            if (node === "build_candidate_shortlist") {
              const candidateCount = Array.isArray(data.candidateShortlist) ? data.candidateShortlist.length : 0;
              activateStage("rules", `Selected ${candidateCount.toLocaleString()} eligible, coverage-balanced candidate${candidateCount === 1 ? "" : "s"} for detailed verification.`);
            }
            if (node === "enrich_trips") {
              const itineraryCount = Array.isArray(data.tripSummaries) ? data.tripSummaries.length : 0;
              activateStage("rules", `Loaded flight-level details for ${itineraryCount.toLocaleString()} promising itinerar${itineraryCount === 1 ? "y" : "ies"}.`);
            }
            if (node === "retrieve_knowledge") {
              if (stageStatus.get("search") !== "complete") {
                completeStage("search", "No new availability search was required for this follow-up.");
              }
              const documentCount = Array.isArray(data.kbDocs) ? data.kbDocs.length : 0;
              completeStage("rules", `Cross-checked ${documentCount.toLocaleString()} relevant program and booking note${documentCount === 1 ? "" : "s"}.`);
              if (searchExecuted) {
                activateStage("rank", "Applying the deterministic value model to the verified options.");
              } else {
                completeStage("rank", "Kept verified flight recommendations.");
              }
            }
            if (Array.isArray(data.recommendations) && searchExecuted) {
              recommendations = data.recommendations as FlightRecommendation[];
              send({ type: "results", recommendations });
              if (node === "rank_recommendations") {
                if (stageStatus.get("rank") !== "active") activateStage("rank", "Applying the deterministic value model to the verified options.");
                completeStage("rank", `Ranked ${recommendations.length.toLocaleString()} option${recommendations.length === 1 ? "" : "s"} by points, fees, stops, and fit.`);
              }
            }
            if (typeof data.draft === "string") {
              answer = data.draft;
              send({ type: "answer_delta", text: answer });
            }
          }
        }

        if (!request.signal.aborted) {
          if (deadlineSignal.aborted) {
            send({
              type: "error",
              code: "deadline_exceeded",
              message: "This request took too long to complete. Please try again.",
              retryable: true,
            });
          } else {
            if (searchExecuted && stageStatus.get("rank") !== "complete") {
              completeStage("rank", `Ranked ${recommendations.length.toLocaleString()} option${recommendations.length === 1 ? "" : "s"}.`);
            } else if (!searchExecuted && stageStatus.get("rank") !== "complete") {
              completeStage("rank", "Kept verified flight recommendations.");
            }
            send({
              type: "complete",
              answer,
              ...(searchExecuted ? { recommendations, searchRan: true } : { searchRan: false }),
            });
          }
        }
      } catch (error) {
        // Never send error.message verbatim — it can carry raw provider API
        // text or other internal detail. Log the real error server-side;
        // send only a small, stable, safe public message.
        console.error("agent run failed", error);
        if (!request.signal.aborted) {
          if (deadlineSignal.aborted) {
            send({
              type: "error",
              code: "deadline_exceeded",
              message: "This request took too long to complete. Please try again.",
              retryable: true,
            });
          } else {
            send({
              type: "error",
              code: "agent_run_failed",
              message: "The travel agent could not complete this request.",
              retryable: true,
            });
          }
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

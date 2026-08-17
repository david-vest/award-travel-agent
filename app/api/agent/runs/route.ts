import { HumanMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { agentRunRequestSchema, type AgentEvent, type AgentStage, type FlightRecommendation } from "../../../../src/contracts/travel-search";
import { describeTripRequest } from "../../../../src/agent/nodes/prepare-ui-search";
import { getAgentGraph } from "../../../../src/agent/runtime";

export const runtime = "nodejs";

const encoder = new TextEncoder();

function eventPayload(event: AgentEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(request: Request) {
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
  const graph = await getAgentGraph();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: AgentEvent) => controller.enqueue(eventPayload(event));
      let recommendations: FlightRecommendation[] = [];
      let answer = "";
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

      try {
        send({ type: "run_started", threadId });
        activateStage("search", body.request ? "Preparing the exact-route award query." : "Reading the follow-up and deciding whether a new search is needed.");

        const graphConfig: RunnableConfig = {
          configurable: { thread_id: threadId },
          metadata: {
            ui_version: "roam-search-v1",
            request_type: body.request ? "structured_search" : "follow_up",
            credit_programs: body.request?.creditCardPrograms ?? [],
            award_programs: body.request?.awardPrograms ?? [],
          },
          tags: ["roam-ui"],
          signal: request.signal,
        };
        const graphStream = await graph.stream(
          {
            messages: [new HumanMessage(message)],
            tripRequest: body.request ?? null,
          },
          { ...graphConfig, streamMode: "updates" },
        );

        for await (const update of graphStream as AsyncIterable<Record<string, Record<string, unknown>>>) {
          if (request.signal.aborted) break;
          for (const [node, data] of Object.entries(update)) {
            if (node === "resolve_ui_locations") {
              activateStage("search", "Resolved the requested places to searchable commercial airports.");
            }
            if (node === "search_awards") {
              const optionCount = Array.isArray(data.awardResults) ? data.awardResults.length : 0;
              completeStage("search", `The exact-route search returned ${optionCount.toLocaleString()} award option${optionCount === 1 ? "" : "s"}.`);
              activateStage("rules", "Checking itinerary details and whether a broader gateway search is worthwhile.");
            }
            if (node === "search_positioning") {
              const attempts = Array.isArray(data.searchAttempts) ? data.searchAttempts.length : 0;
              const optionCount = Array.isArray(data.awardResults) ? data.awardResults.length : 0;
              activateStage("rules", `Expanded to ${attempts || "additional"} route scope${attempts === 1 ? "" : "s"}; validating ${optionCount.toLocaleString()} candidate options.`);
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
              activateStage("rank", "Applying the deterministic value model to the verified options.");
            }
            if (Array.isArray(data.recommendations)) {
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
          if (stageStatus.get("rank") !== "complete") completeStage("rank", `Ranked ${recommendations.length.toLocaleString()} option${recommendations.length === 1 ? "" : "s"}.`);
          send({ type: "complete", answer, recommendations });
        }
      } catch (error) {
        if (!request.signal.aborted) {
          const message = error instanceof Error ? error.message : "The travel agent could not complete this request.";
          send({ type: "error", code: "agent_run_failed", message, retryable: true });
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

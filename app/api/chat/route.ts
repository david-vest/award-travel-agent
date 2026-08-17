import { HumanMessage } from "@langchain/core/messages";
import { buildGraph } from "@/src/agent/graph";
import type { AgentStateType } from "@/src/agent/state";
import { encodeEvent, labelFor, type LinkedOption } from "@/src/agent/stream";
import { UsageTracker } from "@/src/cost/usage-callback";
import { costOf } from "@/src/cost/pricing";
import { aeroConnectionsUrl } from "@/src/deeplink";
import { getClient } from "@/src/agent/nodes/search";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request): Promise<Response> {
  const { message, threadId } = (await req.json()) as {
    message: string;
    threadId: string;
  };

  const stream = new ReadableStream({
    async start(controller) {
      const tracker = new UsageTracker();

      try {
        const graph = await buildGraph();
        const config = {
          configurable: { thread_id: threadId },
          callbacks: [tracker],
          // Tagged so LangSmith can separate demo runs from eval runs.
          metadata: { mode: process.env.SEATS_AERO_API_KEY ? "live" : "replay" },
        };

        let finalState: Partial<AgentStateType> = {};

        // "updates" gives one event per completed node — the source of the
        // progress labels. "messages" would give tokens but not node identity.
        for await (const chunk of await graph.stream(
          { messages: [new HumanMessage(message)] },
          { ...config, streamMode: "updates" },
        )) {
          for (const [node, update] of Object.entries(
            chunk as Record<string, Partial<AgentStateType>>,
          )) {
            finalState = { ...finalState, ...update };
            const label = labelFor(node, finalState);
            if (label !== "…") {
              controller.enqueue(encodeEvent({ type: "status", node, label }));
            }
          }
        }

        // The draft is produced whole by synthesize; emit it as one token event.
        // (Token-level streaming of just the synthesize node is the Phase 7
        // stretch — it needs streamMode "messages" filtered by node tag.)
        const draft = String(finalState.draft ?? "");
        if (draft) controller.enqueue(encodeEvent({ type: "token", text: draft }));

        const options = ((finalState.awardResults ?? []) as LinkedOption[])
          .slice(0, 5)
          .map((o) => ({ ...o, mapUrl: aeroConnectionsUrl(o) }));

        const client = await getClient();
        controller.enqueue(
          encodeEvent({
            type: "done",
            options,
            cost: {
              usd: costOf(tracker.total()),
              cacheHitRate: tracker.cacheHitRate(),
              quotaRemaining: client.quota().remaining,
              perNode: [...tracker.perNode.entries()].map(([node, usage]) => ({
                node,
                usd: costOf(usage),
              })),
            },
          }),
        );

        // Terminal cost readout for the developer, matching the HUD.
        process.stdout.write(tracker.report());
      } catch (err) {
        controller.enqueue(
          encodeEvent({ type: "error", message: (err as Error).message }),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    },
  });
}

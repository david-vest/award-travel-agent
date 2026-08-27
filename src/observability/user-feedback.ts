import { Client } from "langsmith";
import type { AgentFeedback } from "../contracts/travel-search";

const DEFAULT_FAILURE_QUEUE = "roam-uat-failures";

type FeedbackClient = Pick<
  Client,
  "createFeedback" | "listAnnotationQueues" | "createAnnotationQueue" | "addRunsToAnnotationQueue"
>;

async function failureQueueId(client: FeedbackClient): Promise<string> {
  const configured = process.env.LANGSMITH_ANNOTATION_QUEUE_ID;
  if (configured) return configured;

  const name = process.env.LANGSMITH_ANNOTATION_QUEUE_NAME ?? DEFAULT_FAILURE_QUEUE;
  for await (const queue of client.listAnnotationQueues({ name, limit: 1 })) {
    return queue.id;
  }
  const queue = await client.createAnnotationQueue({
    name,
    description: "User-reported Roam recommendation failures selected for human review.",
    rubricInstructions: "Check constraint adherence, ranking quality, evidence use, and explanation clarity.",
  });
  return queue.id;
}

/** Records bounded, balance-free context and routes explicit failures to review. */
export async function recordAgentFeedback(
  feedback: AgentFeedback,
  client: FeedbackClient = new Client(),
): Promise<void> {
  const context = {
    rankingVersion: feedback.rankingVersion,
    preferenceProfile: feedback.preferenceProfile,
    selectedOptionId: feedback.selectedOptionId ?? null,
    candidateIds: feedback.candidateIds,
    evidenceIds: feedback.evidenceIds,
  };

  await client.createFeedback(feedback.runId, feedback.kind === "rating" ? "recommendation_quality" : "selected_option", {
    score: feedback.rating ? feedback.rating === "up" : undefined,
    value: feedback.kind === "selected_option" ? feedback.selectedOptionId : context,
    comment: JSON.stringify(context),
    sourceInfo: { source: "roam-ui", ...context },
  });

  if (feedback.kind === "rating" && feedback.rating === "down") {
    const queueId = await failureQueueId(client);
    await client.addRunsToAnnotationQueue(queueId, [feedback.runId]);
  }
}

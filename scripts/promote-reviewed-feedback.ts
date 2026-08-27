import "dotenv/config";
import { Client } from "langsmith";

const queueName = process.env.LANGSMITH_ANNOTATION_QUEUE_NAME ?? "roam-uat-failures";
const datasetName = process.env.LANGSMITH_FEEDBACK_DATASET ?? "roam-reviewed-recommendation-failures";
const client = new Client();

async function resolveQueueId(): Promise<string> {
  if (process.env.LANGSMITH_ANNOTATION_QUEUE_ID) {
    return process.env.LANGSMITH_ANNOTATION_QUEUE_ID;
  }
  for await (const queue of client.listAnnotationQueues({ name: queueName, limit: 1 })) {
    return queue.id;
  }
  throw new Error(`Annotation queue "${queueName}" was not found.`);
}

async function promoteReviewedRuns() {
  const queueId = await resolveQueueId();
  if (!await client.hasDataset({ datasetName })) {
    await client.createDataset(datasetName, {
      description: "Human-reviewed Roam recommendation failures for offline evaluation.",
    });
  }
  let promoted = 0;
  for await (const run of client.listRunsFromAnnotationQueue(queueId, { status: "completed" })) {
    let alreadyPromoted = false;
    for await (const example of client.listExamples({
      datasetName,
      exampleIds: [run.id],
      limit: 1,
    })) {
      alreadyPromoted = example.id === run.id;
      break;
    }
    if (alreadyPromoted) continue;
    await client.createExample({
      id: run.id,
      inputs: {},
      dataset_name: datasetName,
      source_run_id: run.id,
      use_source_run_io: true,
      metadata: {
        source: "roam-human-review",
        annotationQueueId: queueId,
      },
    });
    promoted += 1;
  }
  console.log(`Promoted ${promoted} reviewed run${promoted === 1 ? "" : "s"} to ${datasetName}.`);
}

await promoteReviewedRuns();

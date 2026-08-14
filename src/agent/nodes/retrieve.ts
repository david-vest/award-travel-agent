import { retrieveKnowledge } from "../../rag/retriever";
import type { AgentStateType } from "../state";
import { lastUserText } from "./triage";

/**
 * Runs AFTER search on the two search branches, and directly after triage on
 * the knowledge branch. The ordering is the point: with results in hand, the
 * retrieval query and metadata filter can both be built from the carriers and
 * programs that actually came back.
 */
export async function retrieveKnowledgeNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  try {
    const docs = await retrieveKnowledge(
      lastUserText(state),
      state.awardResults ?? [],
      state.tripSummaries ?? [],
    );
    return { kbDocs: docs };
  } catch {
    // A vector-store outage degrades the answer; it should not end the turn.
    return { kbDocs: [] };
  }
}

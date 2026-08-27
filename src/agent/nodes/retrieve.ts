import { retrieveEvidenceForOptions, retrieveKnowledge } from "../../rag/retriever";
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
  // Search answers must be anchored in flights. With no flights, generic RAG
  // excerpts become a distracting substitute for the task the user asked us
  // to perform. Pure knowledge questions still retrieve normally.
  if (state.intent !== "knowledge" && (state.awardResults?.length ?? 0) === 0) {
    return { kbDocs: [], optionEvidence: {} };
  }

  const assessableOptions = state.candidateShortlist === undefined
    ? state.awardResults ?? []
    : state.candidateShortlist;
  let docs = [] as Awaited<ReturnType<typeof retrieveKnowledge>>;
  let optionEvidence = {} as Awaited<ReturnType<typeof retrieveEvidenceForOptions>>;
  const degradedReasons = [...(state.degradedReasons ?? [])];
  try {
    docs = await retrieveKnowledge(
      lastUserText(state),
      assessableOptions,
      state.tripSummaries ?? [],
    );
  } catch {
    degradedReasons.push("rag_retrieval_failed");
  }
  if (state.intent !== "knowledge" && assessableOptions.length > 0) {
    try {
      optionEvidence = await retrieveEvidenceForOptions(
        lastUserText(state),
        assessableOptions,
        state.tripSummaries ?? [],
        new Date(),
        state.tripRequest?.creditCardPrograms ?? [],
      );
    } catch {
      degradedReasons.push("option_evidence_retrieval_failed");
    }
  }
  return {
    kbDocs: docs,
    optionEvidence,
    ...(degradedReasons.length !== (state.degradedReasons ?? []).length ? { degradedReasons } : {}),
  };
}

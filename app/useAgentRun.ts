"use client";

import { useCallback, useRef, useState } from "react";
import type {
  AgentEvent,
  AgentFeedback,
  AgentStage,
  ClarificationChoiceId,
  ClarificationRequest,
  FlightRecommendation,
  TripRequest,
} from "../src/contracts/travel-search";
import type { StoredAgentRun } from "../src/local/last-search";

type RunStatus = "idle" | "running" | "clarification" | "complete" | "error";
type StageState = Record<AgentStage, "waiting" | "active" | "complete">;
type StageDetails = Record<AgentStage, string>;
type StageDurations = Partial<Record<AgentStage, number>>;

const waitingStages: StageState = { search: "waiting", rules: "waiting", rank: "waiting" };
const waitingDetails: StageDetails = { search: "Waiting to search.", rules: "Waiting for availability results.", rank: "Waiting for verified options." };

export function useAgentRun() {
  const [status, setStatus] = useState<RunStatus>("idle");
  const [stages, setStages] = useState<StageState>(waitingStages);
  const [stageDetails, setStageDetails] = useState<StageDetails>(waitingDetails);
  const [stageDurations, setStageDurations] = useState<StageDurations>({});
  const [recommendations, setRecommendations] = useState<FlightRecommendation[]>([]);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [clarification, setClarification] = useState<ClarificationRequest | null>(null);
  const [feedbackStatus, setFeedbackStatus] = useState<"idle" | "sending" | "saved" | "error">("idle");
  const controllerRef = useRef<AbortController | null>(null);
  const threadRef = useRef<string | null>(null);

  const processEvent = useCallback((event: AgentEvent) => {
    if (event.type === "run_started") {
      threadRef.current = event.threadId;
      setThreadId(event.threadId);
      setRunId(event.runId);
    } else if (event.type === "stage") {
      setStages((current) => ({ ...current, [event.stage]: event.status }));
      if (event.detail) setStageDetails((current) => ({ ...current, [event.stage]: event.detail! }));
      if (event.elapsedMs != null) setStageDurations((current) => ({ ...current, [event.stage]: event.elapsedMs }));
    } else if (event.type === "results") {
      setRecommendations(event.recommendations);
    } else if (event.type === "answer_delta") {
      setAnswer((current) => current + event.text);
    } else if (event.type === "clarification_required") {
      setClarification(event.clarification);
      setStatus("clarification");
    } else if (event.type === "complete") {
      if (event.recommendations !== undefined) {
        setRecommendations(event.recommendations);
      }
      setAnswer(event.answer);
      setStatus("complete");
    } else if (event.type === "error") {
      setError(event.message);
      setStatus("error");
    }
  }, []);

  const start = useCallback(async (payload: { request?: TripRequest; message?: string; resume?: { choiceId: ClarificationChoiceId } }) => {
    const isResume = Boolean(payload.resume);
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setStatus("running");
    if (!isResume) {
      setStages({ search: "active", rules: "waiting", rank: "waiting" });
      setStageDetails(waitingDetails);
      setStageDurations({});
    }
    setError(null);
    setAnswer("");
    setClarification(null);
    setFeedbackStatus("idle");
    if (payload.request) setRecommendations([]);

    try {
      const response = await fetch("/api/agent/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, threadId: threadRef.current ?? undefined }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error((await response.json().catch(() => null))?.error ?? "Roam could not start the search.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
          if (!data) continue;
          processEvent(JSON.parse(data) as AgentEvent);
        }
      }
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : "Roam could not complete this request.");
      setStatus("error");
    }
  }, [processEvent]);

  const resumeClarification = useCallback((choiceId: ClarificationChoiceId) => {
    if (!threadRef.current) return Promise.resolve();
    return start({ resume: { choiceId } });
  }, [start]);

  const submitFeedback = useCallback(async (feedback: Omit<AgentFeedback, "runId">) => {
    if (!runId) return false;
    setFeedbackStatus("sending");
    try {
      const response = await fetch("/api/agent/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...feedback, runId }),
      });
      if (!response.ok) throw new Error("Feedback could not be saved.");
      setFeedbackStatus("saved");
      return true;
    } catch {
      setFeedbackStatus("error");
      return false;
    }
  }, [runId]);

  const restore = useCallback((snapshot: StoredAgentRun) => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    threadRef.current = snapshot.threadId;
    setStatus(snapshot.status);
    setStages(snapshot.stages);
    setStageDetails(snapshot.stageDetails);
    setStageDurations(snapshot.stageDurations);
    setRecommendations(snapshot.recommendations);
    setAnswer(snapshot.answer);
    setError(snapshot.error);
    setThreadId(snapshot.threadId);
    setRunId(snapshot.runId ?? null);
    setClarification(snapshot.clarification ?? null);
    setFeedbackStatus("idle");
  }, []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    threadRef.current = null;
    setStatus("idle");
    setStages(waitingStages);
    setStageDetails(waitingDetails);
    setStageDurations({});
    setRecommendations([]);
    setAnswer("");
    setError(null);
    setThreadId(null);
    setRunId(null);
    setClarification(null);
    setFeedbackStatus("idle");
  }, []);

  const cancel = useCallback(() => controllerRef.current?.abort(), []);
  return {
    status,
    stages,
    stageDetails,
    stageDurations,
    recommendations,
    answer,
    error,
    threadId,
    runId,
    clarification,
    feedbackStatus,
    start,
    resumeClarification,
    submitFeedback,
    restore,
    reset,
    cancel,
  };
}

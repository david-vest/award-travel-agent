import { z } from "zod";
import { trimMessages, type BaseMessage } from "@langchain/core/messages";
import { chat } from "../models";
import { estimateTokens } from "../cache";
import { plainSystem } from "../cache";
import { TRIAGE_PROMPT } from "../prompts/triage";
import type { AgentStateType, Intent } from "../state";

export const triageSchema = z.object({
  intent: z.enum(["route_search", "discovery", "knowledge"]),
  reasoning: z.string().describe("One sentence explaining the classification"),
});

/** Flattens string or array-form message content to plain text. */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === "string" ? b : ((b as { text?: string }).text ?? ""),
      )
      .join(" ")
      .trim();
  }
  return String(content);
}

/** Most recent human turn, flattened to plain text. */
export function lastUserText(state: AgentStateType): string {
  const messages = (state.messages ?? []) as BaseMessage[];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m._getType() !== "human") continue;
    const c = m.content;
    if (typeof c === "string" || Array.isArray(c)) return flattenContent(c);
  }
  return "";
}

/**
 * Token budget for the prior-turn text hint below, not a message count —
 * a fixed "last N messages" cutoff either truncates a short exchange
 * needlessly or lets one giant message dominate. 1500 tokens covers several
 * normal turns of chat while staying cheap even on a long-running thread.
 */
export const CONVERSATION_CONTEXT_MAX_TOKENS = 1500;

/**
 * Prior turns give a planner/classifier the context to resolve a bare
 * "Tokyo" or a follow-up like "actually nonstop only". Exported so other
 * nodes (e.g. plan-search's and plan-discovery's planners) can reuse the
 * same convention instead of duplicating it. This is a secondary
 * disambiguation hint, not the system's primary memory — sticky SearchPlan
 * fields (state.ts's mergeSearchPlan) are the source of truth for what
 * carries forward turn to turn; this text window just helps a planner
 * resolve a new bare reference against recent chat.
 */
export async function conversationContext(state: AgentStateType): Promise<string> {
  const messages = (state.messages ?? []) as BaseMessage[];
  const prior = messages.slice(0, -1);
  if (prior.length === 0) return "";

  const trimmed = await trimMessages(prior, {
    maxTokens: CONVERSATION_CONTEXT_MAX_TOKENS,
    tokenCounter: (msgs) =>
      msgs.reduce((sum, m) => sum + estimateTokens(flattenContent(m.content)), 0),
    strategy: "last",
  });

  return trimmed
    .map(
      (m) =>
        `${m._getType() === "human" ? "User" : "Assistant"}: ${flattenContent(m.content).slice(0, 300)}`,
    )
    .join("\n");
}

export async function triage(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const text = lastUserText(state);
  const context = await conversationContext(state);

  const model = chat({ effort: "low", disableThinking: true }).withStructuredOutput(
    triageSchema,
    { name: "triage_decision" },
  );

  // Conversation context goes in the USER turn, never the system prompt —
  // it changes every request and would invalidate any cached prefix.
  const userContent = context
    ? `Earlier in this conversation:\n${context}\n\nClassify this message:\n${text}`
    : `Classify this message:\n${text}`;

  // thinking:"adaptive" + withStructuredOutput's forced tool calling don't
  // always compose cleanly (see models.ts). A triage failure should not kill
  // the turn — fall back to "knowledge", matching routers.ts's own default
  // case, which already treats an unresolved intent as the safest path.
  try {
    const result = await model.invoke([
      plainSystem(TRIAGE_PROMPT),
      { role: "user", content: userContent },
    ]);

    return { intent: result.intent as Intent };
  } catch {
    return { intent: "knowledge" };
  }
}

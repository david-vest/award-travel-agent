import { z } from "zod";
import type { BaseMessage } from "@langchain/core/messages";
import { chat } from "../models";
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
 * Prior turns give a planner/classifier the context to resolve a bare
 * "Tokyo" or a follow-up like "actually nonstop only". Exported so other
 * nodes (e.g. plan-search's planner) can reuse the same convention instead
 * of duplicating it.
 */
export function conversationContext(state: AgentStateType): string {
  const messages = (state.messages ?? []) as BaseMessage[];
  const prior = messages.slice(0, -1).slice(-4);
  if (prior.length === 0) return "";
  return prior
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
  const context = conversationContext(state);

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

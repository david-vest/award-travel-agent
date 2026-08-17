// app/components/Chat.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import type { CostSummary, LinkedOption, StreamEvent } from "@/src/agent/stream";
import { StatusTrail, type StatusEntry } from "./StatusTrail";
import { OptionCard } from "./OptionCard";
import { CostHud } from "./CostHud";

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "error";
  content: string;
};

/**
 * The streaming client. Owns four pieces of state: the message list, the
 * live status trail for the in-flight turn, the linked options from the last
 * `done` event, and the cost summary — plus the running session cost total
 * the HUD needs but no single turn carries.
 */
export function Chat() {
  const [threadId] = useState(() => crypto.randomUUID());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [statusTrail, setStatusTrail] = useState<StatusEntry[]>([]);
  const [options, setOptions] = useState<LinkedOption[]>([]);
  const [cost, setCost] = useState<CostSummary | null>(null);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, statusTrail]);

  async function sendMessage(text: string) {
    const question = text.trim();
    if (!question || isStreaming) return;

    setMessages((m) => [...m, { id: crypto.randomUUID(), role: "user", content: question }]);
    setInput("");
    setStatusTrail([]);
    setOptions([]);
    setIsStreaming(true);

    const assistantId = crypto.randomUUID();
    let assistantText = "";
    let assistantStarted = false;

    function handleEvent(event: StreamEvent) {
      switch (event.type) {
        case "status":
          setStatusTrail((t) => [...t, { node: event.node, label: event.label }]);
          break;

        case "token":
          assistantText += event.text;
          if (!assistantStarted) {
            assistantStarted = true;
            setMessages((m) => [
              ...m,
              { id: assistantId, role: "assistant", content: assistantText },
            ]);
          } else {
            setMessages((m) =>
              m.map((msg) => (msg.id === assistantId ? { ...msg, content: assistantText } : msg)),
            );
          }
          break;

        case "done":
          setStatusTrail([]);
          setOptions(event.options);
          setCost(event.cost);
          setSessionTotal((s) => s + event.cost.usd);
          break;

        case "error":
          setMessages((m) => [
            ...m,
            { id: crypto.randomUUID(), role: "error", content: event.message },
          ]);
          break;
      }
    }

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: question, threadId }),
      });

      if (!res.body) throw new Error("Response had no body to stream.");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      // NDJSON over a fetch stream can split a line across chunk boundaries —
      // buffer until a newline actually shows up before parsing.
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.trim()) continue;
          handleEvent(JSON.parse(line) as StreamEvent);
        }
      }

      if (buffer.trim()) {
        handleEvent(JSON.parse(buffer) as StreamEvent);
      }
    } catch (err) {
      setMessages((m) => [
        ...m,
        { id: crypto.randomUUID(), role: "error", content: (err as Error).message },
      ]);
    } finally {
      setIsStreaming(false);
      setStatusTrail([]);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    void sendMessage(input);
  }

  return (
    <div className="chat-layout">
      <div className="chat-column">
        <header className="chat-header">
          <h1>Award Travel Concierge</h1>
          <p>Ask about award flights, discovery trips, or transfer and program rules.</p>
        </header>

        <div className="transcript">
          {messages.map((m) => (
            <div key={m.id} className={`message message-${m.role}`}>
              {m.content}
            </div>
          ))}
          <StatusTrail trail={statusTrail} />
          <div ref={bottomRef} />
        </div>

        {options.length > 0 && (
          <div className="option-grid">
            {options.map((o, i) => (
              <OptionCard key={`${o.availabilityId}-${i}`} option={o} />
            ))}
          </div>
        )}

        <form className="composer" onSubmit={handleSubmit}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about award flights…"
            disabled={isStreaming}
            aria-label="Message"
          />
          <button type="submit" disabled={isStreaming || !input.trim()}>
            {isStreaming ? "Thinking…" : "Send"}
          </button>
        </form>
      </div>

      <CostHud cost={cost} sessionTotal={sessionTotal} />
    </div>
  );
}

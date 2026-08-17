import "dotenv/config";
import { describe, it, expect } from "vitest";
import { chat, MODEL_ID, MODEL_IDS } from "./models";

describe("chat", () => {
  it("targets Claude Sonnet 5 by exact id", () => {
    expect(MODEL_ID).toBe("claude-sonnet-5");
    expect(chat({ effort: "low" }).model).toBe("claude-sonnet-5");
  });

  it("can select the pinned Haiku 4.5 model for fast classification", () => {
    expect(MODEL_IDS.haiku).toBe("claude-haiku-4-5-20251001");
    expect(chat({ effort: "low", model: "haiku" }).model).toBe(
      "claude-haiku-4-5-20251001",
    );
  });

  it("does not send Sonnet-only adaptive effort configuration to Haiku", () => {
    const model = chat({ effort: "low", model: "haiku" }) as unknown as {
      outputConfig?: unknown;
      thinking?: { type: string };
    };
    expect(model.outputConfig).toBeUndefined();
    expect(model.thinking?.type).toBe("disabled");
  });

  it("never sets temperature — Sonnet 5 rejects non-default sampling params", () => {
    const model = chat({ effort: "low" }) as unknown as Record<string, unknown>;
    expect(model.temperature).toBeUndefined();
  });

  it("never sets topP or topK", () => {
    const model = chat({ effort: "low" }) as unknown as Record<string, unknown>;
    expect(model.topP).toBeUndefined();
    expect(model.topK).toBeUndefined();
  });

  it("gives synthesis a larger output budget than classification", () => {
    expect(chat({ effort: "medium" }).maxTokens).toBeGreaterThan(
      chat({ effort: "low" }).maxTokens!,
    );
  });

  it("disables thinking when disableThinking is set, for structured-output calls", () => {
    const model = chat({ effort: "low", disableThinking: true }) as unknown as {
      thinking?: { type: string };
    };
    expect(model.thinking?.type).toBe("disabled");
  });

  it("defaults to adaptive thinking when disableThinking is not set", () => {
    const model = chat({ effort: "low" }) as unknown as { thinking?: { type: string } };
    expect(model.thinking?.type).toBe("adaptive");
  });
});

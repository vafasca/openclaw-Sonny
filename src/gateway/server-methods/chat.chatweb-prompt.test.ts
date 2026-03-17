import { describe, expect, it } from "vitest";
import { buildChatWebPromptFromMessages } from "./chat.js";

describe("buildChatWebPromptFromMessages", () => {
  it("builds a history+current prompt instead of raw passthrough", () => {
    const prompt = buildChatWebPromptFromMessages({
      currentMessage: "desarrolla un login moderno",
      messages: [
        { role: "user", content: [{ type: "text", text: "hola" }] },
        { role: "assistant", content: [{ type: "text", text: "hola!" }] },
      ],
    });

    expect(prompt).toContain("[Chat messages since your last reply - for context]");
    expect(prompt).toContain("[Current message - respond to this]");
    expect(prompt).toContain("User: desarrolla un login moderno");
  });

  it("falls back to current message when no history exists", () => {
    const prompt = buildChatWebPromptFromMessages({
      currentMessage: "mensaje directo",
      messages: [],
    });
    expect(prompt).toBe("mensaje directo");
  });
});

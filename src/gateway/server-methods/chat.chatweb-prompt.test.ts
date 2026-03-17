import { describe, expect, it } from "vitest";
import { buildChatWebPromptFromMessages } from "./chat.js";

describe("buildChatWebPromptFromMessages", () => {
  it("builds history context markers instead of forwarding only raw current message", () => {
    const prompt = buildChatWebPromptFromMessages({
      currentMessage: "desarrolla un login moderno",
      messages: [
        { role: "user", content: [{ type: "text", text: "hola" }] },
        { role: "assistant", content: [{ type: "text", text: "hola, en que te ayudo" }] },
      ],
    });

    expect(prompt).toContain("[Chat messages since your last reply - for context]");
    expect(prompt).toContain("[Current message - respond to this]");
    expect(prompt).toContain("User: hola");
    expect(prompt).toContain("Assistant: hola, en que te ayudo");
    expect(prompt).toContain("User: desarrolla un login moderno");
  });

  it("falls back to raw message when there is no transcript context", () => {
    const prompt = buildChatWebPromptFromMessages({
      currentMessage: "solo este mensaje",
      messages: [],
    });

    expect(prompt).toBe("solo este mensaje");
  });
});

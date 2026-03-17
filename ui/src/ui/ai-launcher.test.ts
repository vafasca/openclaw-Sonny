import { describe, expect, it } from "vitest";
import {
  resolveExternalAiBrowserLabel,
  resolveExternalAiProviderLabel,
  resolveExternalAiUrl,
} from "./ai-launcher.ts";

describe("ai launcher helpers", () => {
  it("resolves provider URLs", () => {
    expect(resolveExternalAiUrl("chatgpt")).toBe("https://chatgpt.com/");
    expect(resolveExternalAiUrl("claude")).toBe("https://claude.ai/");
  });

  it("resolves friendly labels", () => {
    expect(resolveExternalAiProviderLabel("chatgpt")).toBe("ChatGPT");
    expect(resolveExternalAiProviderLabel("claude")).toBe("Claude");
    expect(resolveExternalAiBrowserLabel("chrome")).toBe("Chrome");
    expect(resolveExternalAiBrowserLabel("edge")).toBe("Edge");
  });
});

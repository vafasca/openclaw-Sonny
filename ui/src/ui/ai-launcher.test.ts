import { describe, expect, it } from "vitest";
import { buildExternalAiLaunchUrl, resolveExternalAiUrl } from "./ai-launcher.ts";

describe("ai launcher helpers", () => {
  it("resolves the target URL for each provider", () => {
    expect(resolveExternalAiUrl("chatgpt")).toBe("https://chatgpt.com/");
    expect(resolveExternalAiUrl("claude")).toBe("https://claude.ai/");
  });

  it("builds browser-specific launch links", () => {
    expect(buildExternalAiLaunchUrl({ provider: "chatgpt", browser: "edge" })).toBe(
      "microsoft-edge:https://chatgpt.com/",
    );
    expect(buildExternalAiLaunchUrl({ provider: "claude", browser: "chrome" })).toBe(
      "googlechrome://claude.ai/",
    );
  });
});

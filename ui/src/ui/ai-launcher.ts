export type ExternalAiProvider = "chatgpt" | "claude";
export type ExternalAiBrowser = "chrome" | "edge";

const PROVIDER_URLS: Record<ExternalAiProvider, string> = {
  chatgpt: "https://chatgpt.com/",
  claude: "https://claude.ai/",
};

export function resolveExternalAiUrl(provider: ExternalAiProvider): string {
  return PROVIDER_URLS[provider];
}

export function resolveExternalAiProviderLabel(provider: ExternalAiProvider): string {
  return provider === "claude" ? "Claude" : "ChatGPT";
}

export function resolveExternalAiBrowserLabel(browser: ExternalAiBrowser): string {
  return browser === "edge" ? "Edge" : "Chrome";
}

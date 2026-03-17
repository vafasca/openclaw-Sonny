export type ExternalAiProvider = "chatgpt" | "claude";
export type ExternalAiBrowser = "chrome" | "edge";

const PROVIDER_URLS: Record<ExternalAiProvider, string> = {
  chatgpt: "https://chatgpt.com/",
  claude: "https://claude.ai/",
};

export function resolveExternalAiUrl(provider: ExternalAiProvider): string {
  return PROVIDER_URLS[provider];
}

function toChromeUrl(targetUrl: string): string {
  const parsed = new URL(targetUrl);
  return `googlechrome://${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export function buildExternalAiLaunchUrl(params: {
  provider: ExternalAiProvider;
  browser: ExternalAiBrowser;
}): string {
  const targetUrl = resolveExternalAiUrl(params.provider);
  if (params.browser === "edge") {
    return `microsoft-edge:${targetUrl}`;
  }
  return toChromeUrl(targetUrl);
}

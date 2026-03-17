import {
  createBrowserControlContext,
  startBrowserControlServiceFromConfig,
} from "../../browser/control-service.js";
import { createBrowserRouteDispatcher } from "../../browser/routes/dispatcher.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

type ChatWebSendParams = {
  message?: string;
  provider?: string;
  browser?: string;
  timeoutMs?: number;
};

type ChatWebOpenParams = {
  provider?: string;
  browser?: string;
};

type WebProvider = "chatgpt" | "claude";
type WebBrowser = "chrome" | "edge";

type DispatchResponse = Awaited<
  ReturnType<ReturnType<typeof createBrowserRouteDispatcher>["dispatch"]>
>;

const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_500;

const PROVIDER_URLS: Record<WebProvider, string> = {
  chatgpt: "https://chatgpt.com/",
  claude: "https://claude.ai/",
};

const INPUT_SELECTORS: Record<WebProvider, string[]> = {
  chatgpt: ["#prompt-textarea", "textarea[placeholder*='Message']", "textarea"],
  claude: ["div[contenteditable='true']", "textarea[placeholder*='Message']", "textarea"],
};

function normalizeProvider(value: unknown): WebProvider {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "claude" ? "claude" : "chatgpt";
}

function normalizeBrowser(value: unknown): WebBrowser {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "edge" ? "edge" : "chrome";
}

function normalizeTimeout(value: unknown): number {
  const parsed =
    typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(10_000, parsed));
}

function snapshotText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const rec = payload as Record<string, unknown>;
  return typeof rec.snapshot === "string" ? rec.snapshot.trim() : "";
}

function extractLikelyAssistantText(snapshot: string, prompt: string): string {
  const lines = snapshot
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return "";
  }
  const normalizedPrompt = prompt.trim().toLowerCase();
  const promptIndex = normalizedPrompt
    ? lines.findLastIndex((line) => line.toLowerCase().includes(normalizedPrompt.slice(0, 80)))
    : -1;
  const candidate = promptIndex >= 0 ? lines.slice(promptIndex + 1) : lines;
  const compact = candidate
    .filter((line) => !line.toLowerCase().startsWith("new chat"))
    .filter((line) => !line.toLowerCase().startsWith("search"))
    .slice(-36)
    .join("\n")
    .trim();
  return compact;
}

async function dispatchBrowserRequest(
  dispatch: ReturnType<typeof createBrowserRouteDispatcher>["dispatch"],
  params: {
    method: "GET" | "POST" | "DELETE";
    path: string;
    query?: Record<string, unknown>;
    body?: unknown;
  },
): Promise<DispatchResponse> {
  return await dispatch({
    method: params.method,
    path: params.path,
    query: params.query,
    body: params.body,
  });
}

export const chatWebHandlers: GatewayRequestHandlers = {
  "chat.web.open": async ({ params, respond }) => {
    const typed = params as ChatWebOpenParams;
    const provider = normalizeProvider(typed.provider);
    const browser = normalizeBrowser(typed.browser);

    const ready = await startBrowserControlServiceFromConfig();
    if (!ready) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "browser control is disabled; enable browser control/playwright first",
        ),
      );
      return;
    }

    const dispatcher = createBrowserRouteDispatcher(createBrowserControlContext());
    const profile = browser;
    const targetUrl = PROVIDER_URLS[provider];

    const openTab = await dispatchBrowserRequest(dispatcher.dispatch, {
      method: "POST",
      path: "/tabs/open",
      query: { profile },
      body: { url: targetUrl },
    });
    if (openTab.status >= 400) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `failed to open browser tab (${openTab.status})`, {
          details: openTab.body,
        }),
      );
      return;
    }

    const tabPayload = (openTab.body ?? {}) as Record<string, unknown>;
    const targetId = typeof tabPayload.targetId === "string" ? tabPayload.targetId : "";
    if (!targetId) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "browser tab targetId missing"));
      return;
    }

    await dispatchBrowserRequest(dispatcher.dispatch, {
      method: "POST",
      path: "/navigate",
      query: { profile },
      body: { targetId, url: targetUrl },
    });

    respond(true, {
      provider,
      browser,
      targetId,
      targetUrl,
      mode: "webchat",
    });
  },
  "chat.web.send": async ({ params, respond }) => {
    const typed = params as ChatWebSendParams;
    const message = typeof typed.message === "string" ? typed.message.trim() : "";
    if (!message) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "message is required"));
      return;
    }

    const provider = normalizeProvider(typed.provider);
    const browser = normalizeBrowser(typed.browser);
    const timeoutMs = normalizeTimeout(typed.timeoutMs);
    const profile = browser;

    const ready = await startBrowserControlServiceFromConfig();
    if (!ready) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "browser control is disabled; enable browser control/playwright first",
        ),
      );
      return;
    }

    const dispatcher = createBrowserRouteDispatcher(createBrowserControlContext());

    const openTab = await dispatchBrowserRequest(dispatcher.dispatch, {
      method: "POST",
      path: "/tabs/open",
      query: { profile },
      body: { url: PROVIDER_URLS[provider] },
    });
    if (openTab.status >= 400) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `failed to open browser tab (${openTab.status})`, {
          details: openTab.body,
        }),
      );
      return;
    }

    const tabPayload = (openTab.body ?? {}) as Record<string, unknown>;
    const targetId = typeof tabPayload.targetId === "string" ? tabPayload.targetId : "";
    if (!targetId) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "browser tab targetId missing"));
      return;
    }

    await dispatchBrowserRequest(dispatcher.dispatch, {
      method: "POST",
      path: "/navigate",
      query: { profile },
      body: { targetId, url: PROVIDER_URLS[provider] },
    });

    let submitted = false;
    let submitError: unknown = null;
    for (const selector of INPUT_SELECTORS[provider]) {
      const typeResult = await dispatchBrowserRequest(dispatcher.dispatch, {
        method: "POST",
        path: "/act",
        query: { profile },
        body: {
          kind: "type",
          targetId,
          selector,
          text: message,
          submit: true,
          timeoutMs: 20_000,
        },
      });
      if (typeResult.status < 400) {
        submitted = true;
        break;
      }
      submitError = typeResult.body;
    }

    if (!submitted) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "unable to find a message input on the web AI page; make sure you're logged in",
          { details: submitError },
        ),
      );
      return;
    }

    const startedAt = Date.now();
    let latestSnapshot = "";
    let finalMessage = "";
    while (Date.now() - startedAt < timeoutMs) {
      const snap = await dispatchBrowserRequest(dispatcher.dispatch, {
        method: "GET",
        path: "/snapshot",
        query: {
          profile,
          targetId,
          format: "ai",
          maxChars: 14_000,
          compact: true,
          interactive: false,
        },
      });
      if (snap.status < 400) {
        latestSnapshot = snapshotText(snap.body);
        const extracted = extractLikelyAssistantText(latestSnapshot, message);
        if (extracted.length > 64 && !extracted.toLowerCase().includes(message.toLowerCase())) {
          finalMessage = extracted;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    const responseText = finalMessage || extractLikelyAssistantText(latestSnapshot, message);
    if (!responseText) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "web AI response timed out or could not be captured; try again after opening/logging in",
        ),
      );
      return;
    }

    respond(true, {
      provider,
      browser,
      mode: "webchat",
      message: responseText,
      targetUrl: PROVIDER_URLS[provider],
    });
  },
};

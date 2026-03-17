import { mkdir, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

type ChatWebSendParams = {
  message?: string;
  provider?: string;
  browser?: string;
  timeoutMs?: number;
  sessionKey?: string;
};

type ChatWebOpenParams = {
  provider?: string;
  browser?: string;
  sessionKey?: string;
};

type WebProvider = "chatgpt" | "claude";
type WebBrowser = "chrome" | "edge";

type ActiveBrowserSession = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  provider: WebProvider;
  browserType: WebBrowser;
};

const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_500;

const PROVIDER_URLS: Record<WebProvider, string> = {
  chatgpt: "https://chatgpt.com/",
  claude: "https://claude.ai/",
};

const INPUT_SELECTORS: Record<WebProvider, string[]> = {
  chatgpt: ["#prompt-textarea", "textarea[placeholder*='Message']", "textarea"],
  claude: ["div[contenteditable='true']", "textarea", "div.ProseMirror"],
};

const ASSISTANT_SELECTORS: Record<WebProvider, string[]> = {
  chatgpt: [
    "[data-message-author-role='assistant']",
    "[data-testid='conversation-turn'] [data-message-author-role='assistant']",
  ],
  claude: ["[data-testid='conversation-turn']", "main [class*='prose']", "main article"],
};

const activeSessions = new Map<string, ActiveBrowserSession>();

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

function resolveConversationKey(params: {
  sessionKey?: string;
  provider: WebProvider;
  browser: WebBrowser;
}) {
  const sessionKey =
    typeof params.sessionKey === "string" && params.sessionKey.trim()
      ? params.sessionKey.trim()
      : "default";
  return `${sessionKey}:${params.provider}:${params.browser}`;
}

function isSessionAlive(
  session: ActiveBrowserSession | undefined,
): session is ActiveBrowserSession {
  if (!session) {
    return false;
  }
  if (!session.browser.isConnected()) {
    return false;
  }
  try {
    void session.page.url();
    return true;
  } catch {
    return false;
  }
}

async function cleanupSession(conversationKey: string) {
  const existing = activeSessions.get(conversationKey);
  if (!existing) {
    return;
  }
  activeSessions.delete(conversationKey);
  try {
    await existing.browser.close();
  } catch {
    // Best-effort cleanup.
  }
}

function resolveStoragePath(provider: WebProvider, browser: WebBrowser): string {
  return path.join(
    os.homedir(),
    ".openclaw",
    "browser-data",
    provider,
    `${browser}-storage-state.json`,
  );
}

async function readStoragePathIfExists(storagePath: string): Promise<string | undefined> {
  try {
    await access(storagePath);
    return storagePath;
  } catch {
    return undefined;
  }
}

async function openBrowserSession(args: {
  conversationKey: string;
  provider: WebProvider;
  browser: WebBrowser;
}): Promise<ActiveBrowserSession> {
  const storagePath = resolveStoragePath(args.provider, args.browser);
  await mkdir(path.dirname(storagePath), { recursive: true });

  const channel = args.browser === "edge" ? "msedge" : "chrome";
  const browser = await chromium.launch({
    channel,
    headless: false,
    args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    viewport: null,
    storageState: await readStoragePathIfExists(storagePath),
  });
  const page = await context.newPage();

  await page.goto(PROVIDER_URLS[args.provider], { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(1_000);

  const session: ActiveBrowserSession = {
    browser,
    context,
    page,
    provider: args.provider,
    browserType: args.browser,
  };
  activeSessions.set(args.conversationKey, session);
  browser.on("disconnected", () => {
    const current = activeSessions.get(args.conversationKey);
    if (current === session) {
      activeSessions.delete(args.conversationKey);
    }
  });
  return session;
}

async function getOrOpenSession(args: {
  conversationKey: string;
  provider: WebProvider;
  browser: WebBrowser;
}): Promise<{ session: ActiveBrowserSession; alreadyOpen: boolean }> {
  const existing = activeSessions.get(args.conversationKey);
  if (isSessionAlive(existing)) {
    return { session: existing, alreadyOpen: true };
  }
  await cleanupSession(args.conversationKey);
  const session = await openBrowserSession(args);
  return { session, alreadyOpen: false };
}

async function findInputSelector(page: Page, provider: WebProvider): Promise<string | null> {
  for (const selector of INPUT_SELECTORS[provider]) {
    try {
      await page.waitForSelector(selector, { timeout: 8_000 });
      return selector;
    } catch {
      // Try next selector.
    }
  }
  return null;
}

async function getLatestAssistantText(page: Page, provider: WebProvider): Promise<string> {
  for (const selector of ASSISTANT_SELECTORS[provider]) {
    try {
      const texts = await page.$$eval(selector, (nodes) =>
        nodes.map((node) => node.textContent?.trim() ?? "").filter(Boolean),
      );
      if (texts.length > 0) {
        return texts[texts.length - 1] ?? "";
      }
    } catch {
      // Try next selector.
    }
  }
  return "";
}

async function saveSessionStorage(session: ActiveBrowserSession) {
  const storagePath = resolveStoragePath(session.provider, session.browserType);
  await mkdir(path.dirname(storagePath), { recursive: true });
  await session.context.storageState({ path: storagePath });
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return String(err);
}

export const chatWebHandlers: GatewayRequestHandlers = {
  "chat.web.open": async ({ params, respond }) => {
    const typed = params as ChatWebOpenParams;
    const provider = normalizeProvider(typed.provider);
    const browser = normalizeBrowser(typed.browser);
    const conversationKey = resolveConversationKey({
      sessionKey: typed.sessionKey,
      provider,
      browser,
    });

    try {
      const { session, alreadyOpen } = await getOrOpenSession({
        conversationKey,
        provider,
        browser,
      });
      await session.page.bringToFront();
      respond(true, {
        provider,
        browser,
        mode: "webchat",
        alreadyOpen,
        targetUrl: session.page.url(),
      });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `failed to open ${browser} for ${provider}: ${extractErrorMessage(err)}`,
        ),
      );
    }
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
    const conversationKey = resolveConversationKey({
      sessionKey: typed.sessionKey,
      provider,
      browser,
    });

    try {
      const { session } = await getOrOpenSession({ conversationKey, provider, browser });
      const { page } = session;
      await page.bringToFront();

      const inputSelector = await findInputSelector(page, provider);
      if (!inputSelector) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "unable to find a message input on the web AI page; make sure you're logged in",
          ),
        );
        return;
      }

      const previousAssistantText = await getLatestAssistantText(page, provider);
      await page.click(inputSelector, { timeout: 10_000 });
      await page.fill(inputSelector, message, { timeout: 10_000 });
      await page.keyboard.press("Enter");

      const startedAt = Date.now();
      let latestAssistantText = "";
      while (Date.now() - startedAt < timeoutMs) {
        latestAssistantText = await getLatestAssistantText(page, provider);
        if (latestAssistantText && latestAssistantText !== previousAssistantText) {
          break;
        }
        await page.waitForTimeout(POLL_INTERVAL_MS);
      }

      await saveSessionStorage(session);

      if (!latestAssistantText || latestAssistantText === previousAssistantText) {
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
        message: latestAssistantText,
        targetUrl: page.url(),
      });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `failed to send via ${browser}/${provider}: ${extractErrorMessage(err)}`,
        ),
      );
    }
  },
};

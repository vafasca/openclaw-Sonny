import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

type ChatWebBrowser = "chrome" | "edge";
type ChatWebAssistant = "chatgpt" | "claude";

type LiveSession = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  aiAssistant: ChatWebAssistant;
  browserType: ChatWebBrowser;
  chatId: string | null;
};

const ASSISTANT_URLS: Record<ChatWebAssistant, string> = {
  chatgpt: "https://chatgpt.com/",
  claude: "https://claude.ai/",
};

const activeLoginSessions = new Map<string, { browser: Browser; context: BrowserContext }>();
const activeSessions = new Map<string, LiveSession>();

const logChatWeb = createSubsystemLogger("gateway/chatweb");
const CHATWEB_DEBUG_ENV_KEYS = ["OPENCLAW_DEBUG_MODEL_IO", "OPENCLAW_DEBUG_PROMPT_IO"] as const;
const CHATWEB_DEBUG_MAX_CHARS = 16_000;

function isChatWebIoDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  for (const key of CHATWEB_DEBUG_ENV_KEYS) {
    const raw = env[key];
    if (typeof raw !== "string") {
      continue;
    }
    if (["1", "true", "yes", "on"].includes(raw.trim().toLowerCase())) {
      return true;
    }
  }
  return process.argv.includes("--dev");
}

function trimChatWebDebugText(text: string): string {
  if (text.length <= CHATWEB_DEBUG_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, CHATWEB_DEBUG_MAX_CHARS)}
...<truncated ${text.length - CHATWEB_DEBUG_MAX_CHARS} chars>`;
}

function getDataDir(): string {
  return path.join(resolveStateDir(process.env), "chatweb");
}

function getStoragePath(aiAssistant: ChatWebAssistant): string {
  const dir = path.join(getDataDir(), aiAssistant);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "storage-state.json");
}

function resolveChannel(browser: ChatWebBrowser): "chrome" | "msedge" {
  return browser === "chrome" ? "chrome" : "msedge";
}

function looksLoggedIn(storagePath: string): boolean {
  if (!fs.existsSync(storagePath)) {
    return false;
  }
  try {
    const storage = JSON.parse(fs.readFileSync(storagePath, "utf8")) as { cookies?: unknown[] };
    const cookies = Array.isArray(storage.cookies) ? storage.cookies : [];
    return cookies.length >= 3;
  } catch {
    return false;
  }
}

async function ensureSession(params: {
  conversationId: string;
  browserType: ChatWebBrowser;
  aiAssistant: ChatWebAssistant;
}): Promise<LiveSession> {
  const existing = activeSessions.get(params.conversationId);
  if (existing && existing.browser.isConnected()) {
    return existing;
  }
  const storagePath = getStoragePath(params.aiAssistant);
  if (!fs.existsSync(storagePath)) {
    throw new Error("No saved login session. Start chatweb.login.start first.");
  }
  const browser = await chromium.launch({
    channel: resolveChannel(params.browserType),
    headless: false,
    args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    viewport: null,
    storageState: storagePath,
  });
  const page = await context.newPage();
  await page.goto(ASSISTANT_URLS[params.aiAssistant], {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(1_500);
  const next: LiveSession = {
    browser,
    context,
    page,
    aiAssistant: params.aiAssistant,
    browserType: params.browserType,
    chatId: null,
  };
  activeSessions.set(params.conversationId, next);
  return next;
}

async function extractAssistantReply(
  page: Page,
  assistant: ChatWebAssistant,
): Promise<string | null> {
  await page.waitForTimeout(3_000);
  const startedAt = Date.now();
  while (Date.now() - startedAt < 120_000) {
    const stop = page
      .locator('button[aria-label="Stop generating"], button[data-testid="stop-button"]')
      .first();
    const visible = await stop.isVisible().catch(() => false);
    if (!visible) {
      break;
    }
    await page.waitForTimeout(1_000);
  }
  const selectors =
    assistant === "chatgpt"
      ? [
          '[data-message-author-role="assistant"]:last-child',
          '[data-testid="conversation-turn"]:last-child [data-message-author-role="assistant"]',
        ]
      : ['[data-testid="conversation-turn"]:last-child', '[class*="prose"]:last-of-type'];
  for (const selector of selectors) {
    const loc = page.locator(selector).last();
    const text = (await loc.textContent().catch(() => null))?.trim();
    if (text) {
      return text;
    }
  }
  return null;
}

async function writeChatInput(params: {
  page: Page;
  selector: string;
  message: string;
}): Promise<void> {
  const locator = params.page.locator(params.selector).first();
  await locator.click();
  const kind = await locator.evaluate((element) => {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      return "field";
    }
    if (element instanceof HTMLElement && element.isContentEditable) {
      return "contenteditable";
    }
    return "unknown";
  });

  if (kind === "field") {
    await locator.evaluate((element, value) => {
      if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
        element.focus();
        element.value = value;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, params.message);
    return;
  }

  await locator.evaluate((element, value) => {
    if (!(element instanceof HTMLElement)) {
      return;
    }
    element.focus();
    element.textContent = value;
    element.dispatchEvent(
      new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }),
    );
  }, params.message);
}

async function submitChatInput(params: { page: Page; assistant: ChatWebAssistant }): Promise<void> {
  const selectors =
    params.assistant === "chatgpt"
      ? [
          'button[data-testid="send-button"]',
          'button[aria-label*="Send"]',
          'button[aria-label*="send"]',
          'button[type="submit"]',
        ]
      : [
          'button[aria-label*="Send"]',
          'button[aria-label*="send"]',
          'button[data-testid="send-button"]',
          'button[type="submit"]',
        ];

  for (const selector of selectors) {
    const button = params.page.locator(selector).first();
    const visible = await button.isVisible().catch(() => false);
    const enabled = await button.isEnabled().catch(() => false);
    if (visible && enabled) {
      await button.click();
      return;
    }
  }

  await params.page.keyboard.press("Enter");
}

export async function sendChatWebMessage(params: {
  conversationId: string;
  message: string;
  aiAssistant: ChatWebAssistant;
  browserType: ChatWebBrowser;
}): Promise<string | null> {
  const debugEnabled = isChatWebIoDebugEnabled(process.env);
  if (debugEnabled) {
    logChatWeb.info(
      `[model-io] request mode=chatweb conversationId=${params.conversationId} assistant=${params.aiAssistant} browser=${params.browserType} prompt=${trimChatWebDebugText(params.message)}`,
    );
  }
  const session = await ensureSession({
    conversationId: params.conversationId,
    aiAssistant: params.aiAssistant,
    browserType: params.browserType,
  });

  const response = await sendViaChatWeb({ session, message: params.message });
  if (debugEnabled) {
    logChatWeb.info(
      `[model-io] response mode=chatweb conversationId=${params.conversationId} assistant=${params.aiAssistant} browser=${params.browserType} response=${trimChatWebDebugText((response ?? "").trim() || "<empty>")}`,
    );
  }
  return response;
}

async function sendViaChatWeb(params: {
  session: LiveSession;
  message: string;
}): Promise<string | null> {
  const inputSelectors =
    params.session.aiAssistant === "chatgpt"
      ? ["#prompt-textarea", 'textarea[placeholder*="Message"]', 'div[contenteditable="true"]']
      : ['div[contenteditable="true"]', "textarea", "div.ProseMirror"];

  let input: string | null = null;
  for (const selector of inputSelectors) {
    const found = await params.session.page
      .locator(selector)
      .first()
      .isVisible()
      .catch(() => false);
    if (found) {
      input = selector;
      break;
    }
  }
  if (!input) {
    throw new Error("Unable to find chat input in selected assistant page");
  }

  await writeChatInput({
    page: params.session.page,
    selector: input,
    message: params.message,
  });
  await submitChatInput({
    page: params.session.page,
    assistant: params.session.aiAssistant,
  });

  const response = await extractAssistantReply(params.session.page, params.session.aiAssistant);
  const storagePath = getStoragePath(params.session.aiAssistant);
  await params.session.context.storageState({ path: storagePath });
  return response;
}

export const chatWebHandlers: GatewayRequestHandlers = {
  "chatweb.status": async ({ respond }) => {
    const config = loadConfig().chatweb;
    const chatgptStorage = getStoragePath("chatgpt");
    const claudeStorage = getStoragePath("claude");
    respond(
      true,
      {
        enabled: config?.enabled === true,
        browser: config?.browser ?? "chrome",
        aiAssistant: config?.aiAssistant ?? "chatgpt",
        chatgpt: {
          loggedIn: looksLoggedIn(chatgptStorage),
          hasStorage: fs.existsSync(chatgptStorage),
        },
        claude: {
          loggedIn: looksLoggedIn(claudeStorage),
          hasStorage: fs.existsSync(claudeStorage),
        },
      },
      undefined,
    );
  },
  "chatweb.login.start": async ({ params, respond }) => {
    const aiAssistant = (params as { aiAssistant?: ChatWebAssistant }).aiAssistant;
    const browserType = (params as { browser?: ChatWebBrowser }).browser;
    if (!aiAssistant || !browserType) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "aiAssistant and browser are required"),
      );
      return;
    }
    const sessionKey = `${aiAssistant}-${browserType}`;
    const existing = activeLoginSessions.get(sessionKey);
    if (existing) {
      await existing.browser.close().catch(() => {});
      activeLoginSessions.delete(sessionKey);
    }
    const browser = await chromium.launch({
      channel: resolveChannel(browserType),
      headless: false,
      args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
    });
    const storagePath = getStoragePath(aiAssistant);
    const context = await browser.newContext({
      viewport: null,
      storageState: fs.existsSync(storagePath) ? storagePath : undefined,
    });
    const page = await context.newPage();
    await page.goto(ASSISTANT_URLS[aiAssistant], {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    activeLoginSessions.set(sessionKey, { browser, context });
    respond(true, { success: true, sessionKey }, undefined);
  },
  "chatweb.login.confirm": async ({ params, respond }) => {
    const sessionKey = (params as { sessionKey?: string }).sessionKey;
    if (!sessionKey) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionKey is required"));
      return;
    }
    const session = activeLoginSessions.get(sessionKey);
    if (!session) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "active login session not found"),
      );
      return;
    }
    const [assistant] = sessionKey.split("-") as [ChatWebAssistant];
    const storagePath = getStoragePath(assistant);
    await session.context.storageState({ path: storagePath });
    await session.browser.close().catch(() => {});
    activeLoginSessions.delete(sessionKey);
    respond(true, { success: true }, undefined);
  },

  "chatweb.configure": async ({ params, respond }) => {
    const enabledRaw = (params as { enabled?: unknown }).enabled;
    const assistantRaw = (params as { aiAssistant?: unknown }).aiAssistant;
    const browserRaw = (params as { browser?: unknown }).browser;

    if (enabledRaw !== undefined && typeof enabledRaw !== "boolean") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "enabled must be a boolean"),
      );
      return;
    }
    if (assistantRaw !== undefined && assistantRaw !== "chatgpt" && assistantRaw !== "claude") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "aiAssistant must be chatgpt or claude"),
      );
      return;
    }
    if (browserRaw !== undefined && browserRaw !== "chrome" && browserRaw !== "edge") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "browser must be chrome or edge"),
      );
      return;
    }

    const cfg = loadConfig();
    const current = cfg.chatweb ?? {};
    const nextCfg = {
      ...cfg,
      chatweb: {
        enabled: enabledRaw ?? current.enabled ?? false,
        aiAssistant:
          (assistantRaw as ChatWebAssistant | undefined) ?? current.aiAssistant ?? "chatgpt",
        browser: (browserRaw as ChatWebBrowser | undefined) ?? current.browser ?? "chrome",
      },
    };

    await writeConfigFile(nextCfg);

    respond(true, { success: true, chatweb: nextCfg.chatweb }, undefined);
  },

  "chatweb.send": async ({ params, respond }) => {
    const cfg = loadConfig().chatweb;
    if (!cfg?.enabled) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "chatweb mode is not enabled"),
      );
      return;
    }
    const message = (params as { message?: string }).message?.trim();
    const conversationId = (params as { conversationId?: string }).conversationId?.trim();
    if (!message || !conversationId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "message and conversationId are required"),
      );
      return;
    }
    const aiAssistant = (cfg.aiAssistant ?? "chatgpt") as ChatWebAssistant;
    const browserType = (cfg.browser ?? "chrome") as ChatWebBrowser;
    try {
      const responseText = await sendChatWebMessage({
        conversationId,
        message,
        aiAssistant,
        browserType,
      });
      respond(true, { response: responseText ?? "", aiAssistant, browser: browserType }, undefined);
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
    }
  },
};

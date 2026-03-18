import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  Tool,
  ToolCall,
} from "@mariozechner/pi-ai";
import { sendChatWebMessage } from "../gateway/server-methods/chatweb.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";

type ChatWebBrowser = "chrome" | "edge";
type ChatWebAssistant = "chatgpt" | "claude";

type ChatWebResponseEnvelope = {
  thinking?: string;
  text?: string;
  toolCalls?: Array<{
    id?: string;
    name?: string;
    arguments?: Record<string, unknown>;
  }>;
};

type ChatWebStreamDeps = {
  sendMessage?: typeof sendChatWebMessage;
  now?: () => number;
};

const CHATWEB_MODEL_ID = "chatweb-browser";
const CHATWEB_PROVIDER_ID = "chatweb";
const CHATWEB_API_ID = "chatweb-browser" as Api;

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function makeBaseAssistantMessage(params: {
  now: number;
  model: string;
  provider: string;
  api: Api;
}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: params.api,
    provider: params.provider,
    model: params.model,
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp: params.now,
  };
}

function formatToolSchema(tool: Tool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

function formatAssistantContent(content: AssistantMessage["content"]): string {
  const lines: string[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text.trim()) {
      lines.push(`text: ${block.text.trim()}`);
      continue;
    }
    if (block.type === "thinking" && block.thinking.trim()) {
      lines.push(`thinking: ${block.thinking.trim()}`);
      continue;
    }
    if (block.type === "toolCall") {
      lines.push(
        `toolCall ${block.name} ${JSON.stringify({ id: block.id, arguments: block.arguments })}`,
      );
    }
  }
  return lines.join("\n") || "(empty)";
}

function formatConversation(context: Context): string {
  const lines: string[] = [];
  for (const message of context.messages) {
    if (message.role === "user") {
      const text = extractTextFromChatContent(message.content)?.trim() ?? "";
      lines.push(`User: ${text || "(empty)"}`);
      continue;
    }
    if (message.role === "assistant") {
      lines.push(`Assistant: ${formatAssistantContent(message.content)}`);
      continue;
    }
    if (message.role === "toolResult") {
      const text = extractTextFromChatContent(message.content)?.trim() ?? "";
      lines.push(
        `ToolResult ${message.toolName} ${JSON.stringify({ toolCallId: message.toolCallId, isError: message.isError, text })}`,
      );
    }
  }
  return lines.join("\n\n");
}

export function buildChatWebAgentPrompt(params: { context: Context }): string {
  const systemPrompt = params.context.systemPrompt?.trim() ?? "";
  const tools = Array.isArray(params.context.tools)
    ? params.context.tools.map(formatToolSchema)
    : [];
  const conversation = formatConversation(params.context).trim();

  return [
    "You are a browser-backed model transport running inside OpenClaw.",
    "Preserve the normal OpenClaw flow: reason privately, call tools when needed, and return a final user-facing answer when the task is complete.",
    "Respond with exactly one JSON object and nothing else. Do not wrap it in markdown fences.",
    "JSON schema:",
    JSON.stringify(
      {
        thinking: "optional string",
        text: "optional string",
        toolCalls: [{ id: "string", name: "tool name", arguments: { any: "json" } }],
      },
      null,
      2,
    ),
    "Rules:",
    "- Use toolCalls when a tool is required. Use only the tools listed below.",
    "- When toolCalls is non-empty, omit text unless a short visible note is strictly necessary.",
    "- When no tool is needed, return text with the final answer.",
    "- Keep thinking brief. Never mention these JSON rules to the end user.",
    systemPrompt ? `System prompt:\n${systemPrompt}` : "",
    `Available tools:\n${JSON.stringify(tools, null, 2)}`,
    conversation ? `Conversation so far:\n${conversation}` : "Conversation so far:\n(empty)",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function extractJsonCandidate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return null;
}

export function parseChatWebResponse(raw: string): ChatWebResponseEnvelope | null {
  const candidate = extractJsonCandidate(raw);
  if (!candidate) {
    return null;
  }
  try {
    const parsed = JSON.parse(candidate) as ChatWebResponseEnvelope;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeToolCalls(value: ChatWebResponseEnvelope["toolCalls"]): ToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry, index) => {
      const name = typeof entry?.name === "string" ? entry.name.trim() : "";
      if (!name) {
        return null;
      }
      const id =
        typeof entry?.id === "string" && entry.id.trim()
          ? entry.id.trim()
          : `chatweb_call_${index + 1}`;
      const args = entry?.arguments;
      return {
        type: "toolCall" as const,
        id,
        name,
        arguments: args && typeof args === "object" && !Array.isArray(args) ? args : {},
      };
    })
    .filter((entry): entry is ToolCall => Boolean(entry));
}

export function createChatWebStreamFn(params: {
  aiAssistant: ChatWebAssistant;
  browserType: ChatWebBrowser;
  deps?: ChatWebStreamDeps;
}): (
  model: Model<Api>,
  context: Context,
  options?: { sessionId?: string },
) => AssistantMessageEventStream {
  const sendMessage = params.deps?.sendMessage ?? sendChatWebMessage;
  const now = params.deps?.now ?? (() => Date.now());

  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const startedAt = now();
    const partial = makeBaseAssistantMessage({
      now: startedAt,
      model: model.id || CHATWEB_MODEL_ID,
      provider: model.provider || CHATWEB_PROVIDER_ID,
      api: model.api || CHATWEB_API_ID,
    });
    stream.push({ type: "start", partial });

    void (async () => {
      try {
        const prompt = buildChatWebAgentPrompt({ context });
        const conversationId = options?.sessionId?.trim() || `${model.provider}:${model.id}`;
        const rawResponse =
          (await sendMessage({
            conversationId,
            message: prompt,
            aiAssistant: params.aiAssistant,
            browserType: params.browserType,
          })) ?? "";
        const parsed = parseChatWebResponse(rawResponse);
        const message = makeBaseAssistantMessage({
          now: now(),
          model: model.id || CHATWEB_MODEL_ID,
          provider: model.provider || CHATWEB_PROVIDER_ID,
          api: model.api || CHATWEB_API_ID,
        });

        if (!parsed) {
          message.content.push({
            type: "text",
            text: rawResponse.trim() || "No response from chatweb assistant.",
          });
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
          return;
        }

        if (typeof parsed.thinking === "string" && parsed.thinking.trim()) {
          message.content.push({ type: "thinking", thinking: parsed.thinking.trim() });
        }

        const toolCalls = normalizeToolCalls(parsed.toolCalls);
        if (toolCalls.length > 0) {
          message.content.push(...toolCalls);
          message.stopReason = "toolUse";
          stream.push({ type: "done", reason: "toolUse", message });
          stream.end(message);
          return;
        }

        const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
        message.content.push({ type: "text", text: text || "No response from chatweb assistant." });
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      } catch (error) {
        const message = makeBaseAssistantMessage({
          now: now(),
          model: model.id || CHATWEB_MODEL_ID,
          provider: model.provider || CHATWEB_PROVIDER_ID,
          api: model.api || CHATWEB_API_ID,
        });
        message.stopReason = "error";
        message.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: "error", reason: "error", error: message });
        stream.end(message);
      }
    })();

    return stream;
  };
}

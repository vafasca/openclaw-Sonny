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

type ChatWebBrowser = "chrome" | "edge";
type ChatWebAssistant = "chatgpt" | "claude";

type ChatWebResponseEnvelope = {
  role?: string;
  stopReason?: string;
  thinking?: string;
  text?: string;
  content?: Array<{
    type?: string;
    thinking?: string;
    text?: string;
    id?: string;
    name?: string;
    arguments?: Record<string, unknown>;
  }>;
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

type AssistantContentBlock = AssistantMessage["content"][number];

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

function formatMessageContent(message: Context["messages"][number]): unknown {
  if (message.role === "user") {
    return message.content;
  }
  if (message.role === "assistant") {
    return message.content.map((block) => {
      if (block.type === "thinking") {
        return { type: "thinking", thinking: block.thinking };
      }
      if (block.type === "text") {
        return { type: "text", text: block.text };
      }
      if (block.type === "toolCall") {
        return {
          type: "toolCall",
          id: block.id,
          name: block.name,
          arguments: block.arguments,
        };
      }
      return block;
    });
  }
  if (message.role === "toolResult") {
    return {
      type: "toolResult",
      toolName: message.toolName,
      toolCallId: message.toolCallId,
      isError: message.isError,
      content: message.content,
    };
  }
  return null;
}

function formatConversation(context: Context): string {
  return JSON.stringify(
    context.messages.map((message) => ({
      role: message.role,
      content: formatMessageContent(message),
      ...(message.role === "toolResult"
        ? {
            toolName: message.toolName,
            toolCallId: message.toolCallId,
            isError: message.isError,
          }
        : {}),
    })),
    null,
    2,
  );
}

export function buildChatWebAgentPrompt(params: { context: Context }): string {
  const systemPrompt = params.context.systemPrompt?.trim() ?? "";
  const tools = Array.isArray(params.context.tools)
    ? params.context.tools.map(formatToolSchema)
    : [];
  const conversation = formatConversation(params.context).trim();

  return [
    "This is an OpenClaw model turn being executed through a browser-backed assistant.",
    "Follow the provided system prompt, conversation history, and tool definitions as faithfully as possible.",
    "Do not rewrite or summarize the system prompt. Continue the conversation exactly as the model would.",
    "Return exactly one JSON object and nothing else. Do not wrap it in markdown fences.",
    "Start with { and end with }. Do not include any preamble, postscript, or markdown.",
    "Return the next assistant turn using OpenClaw-style content blocks.",
    "Supported response schema:",
    JSON.stringify(
      {
        role: "assistant",
        stopReason: "stop | toolUse",
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "toolCall", id: "call id", name: "tool name", arguments: { any: "json" } },
          { type: "text", text: "final user-visible response" },
        ],
      },
      null,
      2,
    ),
    "Rules:",
    "- Keep the system prompt semantics intact.",
    "- Use toolCall blocks when a tool is required. Use only the tools listed below.",
    "- When returning a toolCall, set stopReason to toolUse.",
    "- When returning a final answer, include a text block and set stopReason to stop.",
    "- Thinking blocks are optional and private. Text blocks are user-visible.",
    "- Tool call arguments must be valid JSON. Escape backslashes in Windows paths and escape quotes inside file contents.",
    systemPrompt
      ? `System message:\n${JSON.stringify({ role: "system", content: systemPrompt }, null, 2)}`
      : 'System message:\n{"role":"system","content":""}',
    `Messages:\n${conversation || "[]"}`,
    `Tools:\n${JSON.stringify(tools, null, 2)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildRepairPrompt(rawResponse: string): string {
  return [
    "Your previous message was not machine-parseable.",
    "Convert that previous answer into exactly one valid JSON object only.",
    "Do not include markdown fences. Do not include explanations.",
    "Start with { and end with }.",
    "Allowed schema:",
    JSON.stringify(
      {
        role: "assistant",
        stopReason: "stop | toolUse",
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "toolCall", id: "call id", name: "tool name", arguments: { any: "json" } },
          { type: "text", text: "final user-visible response" },
        ],
      },
      null,
      2,
    ),
    "If your previous answer included file contents, include them as toolCall arguments/content faithfully.",
    `Previous raw answer:\n${rawResponse.trim() || "<empty>"}`,
  ].join("\n\n");
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

function normalizeContentBlocks(
  value: ChatWebResponseEnvelope["content"],
): AssistantContentBlock[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const blocks: AssistantContentBlock[] = [];
  for (const [index, block] of value.entries()) {
    if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
      blocks.push({ type: "thinking", thinking: block.thinking.trim() });
      continue;
    }
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      blocks.push({ type: "text", text: block.text.trim() });
      continue;
    }
    if (block?.type === "toolCall") {
      const name = typeof block.name === "string" ? block.name.trim() : "";
      if (!name) {
        continue;
      }
      blocks.push({
        type: "toolCall",
        id:
          typeof block.id === "string" && block.id.trim()
            ? block.id.trim()
            : `chatweb_call_${index + 1}`,
        name,
        arguments:
          block.arguments && typeof block.arguments === "object" && !Array.isArray(block.arguments)
            ? block.arguments
            : {},
      });
    }
  }
  return blocks;
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
        const firstRawResponse =
          (await sendMessage({
            conversationId,
            message: prompt,
            aiAssistant: params.aiAssistant,
            browserType: params.browserType,
          })) ?? "";
        let rawResponse = firstRawResponse;
        let parsed = parseChatWebResponse(rawResponse);
        if (!parsed) {
          const repairPrompt = buildRepairPrompt(firstRawResponse);
          const repairedRawResponse =
            (await sendMessage({
              conversationId,
              message: repairPrompt,
              aiAssistant: params.aiAssistant,
              browserType: params.browserType,
            })) ?? "";
          if (repairedRawResponse.trim()) {
            rawResponse = repairedRawResponse;
            parsed = parseChatWebResponse(repairedRawResponse);
          }
        }
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

        const normalizedContent = normalizeContentBlocks(parsed.content);
        if (normalizedContent.length > 0) {
          message.content.push(...normalizedContent);
        } else {
          if (typeof parsed.thinking === "string" && parsed.thinking.trim()) {
            message.content.push({ type: "thinking", thinking: parsed.thinking.trim() });
          }
          const toolCalls = normalizeToolCalls(parsed.toolCalls);
          if (toolCalls.length > 0) {
            message.content.push(...toolCalls);
          }
          const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
          if (text) {
            message.content.push({ type: "text", text });
          }
        }

        const toolCalls = message.content.filter(
          (block): block is ToolCall => block.type === "toolCall",
        );
        if (toolCalls.length > 0) {
          message.stopReason = "toolUse";
          stream.push({ type: "done", reason: "toolUse", message });
          stream.end(message);
          return;
        }

        const hasText = message.content.some((block) => block.type === "text");
        if (!hasText) {
          message.content.push({ type: "text", text: "No response from chatweb assistant." });
        }
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

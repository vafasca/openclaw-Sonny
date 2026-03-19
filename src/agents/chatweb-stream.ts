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

type ParseChatWebResponseResult = {
  response: ChatWebResponseEnvelope | null;
  error?: string;
  repaired?: boolean;
};

type FileBlockMap = Map<string, string>;

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

function makeChatWebAssistantMessage(now: number): AssistantMessage {
  return makeBaseAssistantMessage({
    now,
    model: CHATWEB_MODEL_ID,
    provider: CHATWEB_PROVIDER_ID,
    api: CHATWEB_API_ID,
  });
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
    "CRITICAL RULE — FILE OPERATIONS:",
    "- When the task involves creating, writing, or saving files, you MUST return toolCall blocks using the write tool.",
    '- For file operations, stopReason MUST be "toolUse".',
    "- Do NOT return file contents in a text response for file operations.",
    "- Do NOT claim you cannot write files. You can and must use toolCall.",
    "- If a task requires 3 files, return 3 separate toolCall blocks.",
    "OPTIONAL SAFE FILE-CONTENT FORMAT (recommended for long HTML/CSS/JS):",
    '- In toolCall arguments, set content to a placeholder like "<<FILE:index_html>>".',
    "- After the JSON object, append file blocks in this exact format:",
    "<<FILE:index_html>",
    "<!DOCTYPE html>...",
    "<<END_FILE:index_html>>",
    "The parser will replace placeholder content values with these file blocks.",
    systemPrompt
      ? `System message:\n${JSON.stringify({ role: "system", content: systemPrompt }, null, 2)}`
      : 'System message:\n{"role":"system","content":""}',
    `Messages:\n${conversation || "[]"}`,
    `Tools:\n${JSON.stringify(tools, null, 2)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildRepairPrompt(rawResponse: string, parseError?: string): string {
  const errorHint = parseError
    ? [
        `Parse error: ${parseError}`,
        "Common cause: unescaped quotes inside JSON string values.",
        'WRONG: "content":"<html lang="es">"',
        'RIGHT:  "content":"<html lang=\\"es\\">"',
      ].join("\n")
    : "";
  return [
    "Your previous message was not machine-parseable.",
    "Convert that previous answer into exactly one valid JSON object only.",
    "Do not include markdown fences. Do not include explanations.",
    "Start with { and end with }.",
    errorHint,
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

function buildEmptyRetryPrompt(originalPrompt: string): string {
  return [
    "Your previous response was empty.",
    "Retry the full task now and return exactly one JSON object only.",
    "Do not include markdown fences. Do not include explanations.",
    "Start with { and end with }.",
    "Original task payload:",
    originalPrompt,
  ].join("\n\n");
}

function buildToolUseRetryPrompt(params: {
  originalPrompt: string;
  previousResponse: string;
}): string {
  return [
    'Your previous response used stopReason:"stop" without required file tool calls.',
    "This task requires file creation/writes.",
    'You MUST return toolCall blocks using the "write" tool and set stopReason to "toolUse".',
    "Do NOT put file contents in a text response.",
    "Do NOT ask the user to copy/paste manually.",
    "Original task payload:",
    params.originalPrompt,
    `Previous raw answer:\n${params.previousResponse.trim() || "<empty>"}`,
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

function escapeLikelyUnescapedQuotes(candidate: string): string {
  let result = "";
  let insideString = false;
  let escaped = false;

  for (let i = 0; i < candidate.length; i += 1) {
    const char = candidate[i];
    if (char === "\\" && insideString && !escaped) {
      escaped = true;
      result += char;
      continue;
    }
    if (char === '"' && !escaped) {
      if (!insideString) {
        insideString = true;
        result += char;
        continue;
      }

      let j = i + 1;
      while (j < candidate.length && /\s/.test(candidate[j])) {
        j += 1;
      }
      const next = candidate[j];
      const canCloseString = next === "," || next === "}" || next === "]" || next === ":";
      if (canCloseString) {
        insideString = false;
        result += char;
      } else {
        result += '\\"';
      }
      continue;
    }

    if (escaped) {
      escaped = false;
    }
    result += char;
  }

  return result;
}

function fallbackJsonRepair(candidate: string): string {
  return candidate
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
}

function extractFileBlocks(raw: string): FileBlockMap {
  const blocks: FileBlockMap = new Map();
  const regex = /<<FILE:([a-zA-Z0-9_.-]+)>>\s*\n([\s\S]*?)\n<<END_FILE:\1>>/g;
  for (const match of raw.matchAll(regex)) {
    const id = match[1]?.trim();
    const content = match[2] ?? "";
    if (id) {
      blocks.set(`<<FILE:${id}>>`, content);
    }
  }
  return blocks;
}

function applyFileBlocksToValue(value: unknown, blocks: FileBlockMap): unknown {
  if (typeof value === "string") {
    return blocks.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => applyFileBlocksToValue(entry, blocks));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, applyFileBlocksToValue(entry, blocks)]),
    );
  }
  return value;
}

function applyFileBlocksToEnvelope(
  envelope: ChatWebResponseEnvelope,
  blocks: FileBlockMap,
): ChatWebResponseEnvelope {
  if (blocks.size === 0) {
    return envelope;
  }
  return {
    ...envelope,
    content: Array.isArray(envelope.content)
      ? envelope.content.map((block) =>
          block?.type === "toolCall"
            ? {
                ...block,
                arguments: applyFileBlocksToValue(block.arguments, blocks) as Record<
                  string,
                  unknown
                >,
              }
            : block,
        )
      : envelope.content,
    toolCalls: Array.isArray(envelope.toolCalls)
      ? envelope.toolCalls.map((toolCall) => ({
          ...toolCall,
          arguments: applyFileBlocksToValue(toolCall.arguments, blocks) as Record<string, unknown>,
        }))
      : envelope.toolCalls,
  };
}

function parseCandidate(candidateRaw: string): ParseChatWebResponseResult {
  const candidate = extractJsonCandidate(candidateRaw);
  if (!candidate) {
    return { response: null, error: "No JSON object found in assistant response." };
  }
  try {
    const parsed = JSON.parse(candidate) as ChatWebResponseEnvelope;
    return parsed && typeof parsed === "object"
      ? { response: parsed }
      : { response: null, error: "Parsed value was not an object." };
  } catch (error) {
    try {
      const repaired = JSON.parse(fallbackJsonRepair(candidate)) as ChatWebResponseEnvelope;
      if (repaired && typeof repaired === "object") {
        return { response: repaired, repaired: true };
      }
    } catch {
      // continue to heuristic repair fallback
    }
    const repairedCandidate = escapeLikelyUnescapedQuotes(candidate);
    if (repairedCandidate !== candidate) {
      try {
        const repaired = JSON.parse(repairedCandidate) as ChatWebResponseEnvelope;
        if (repaired && typeof repaired === "object") {
          return { response: repaired, repaired: true };
        }
      } catch {
        // fall through to original parse error
      }
    }
    return {
      response: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function parseChatWebResponseDetailed(raw: string): ParseChatWebResponseResult {
  function unwrapNestedEnvelope(
    envelope: ChatWebResponseEnvelope,
    depth: number,
  ): ParseChatWebResponseResult {
    if (depth >= 2) {
      return { response: envelope };
    }
    const content = envelope.content;
    if (
      Array.isArray(content) &&
      content.length === 1 &&
      content[0]?.type === "text" &&
      typeof content[0].text === "string"
    ) {
      const nested = parseCandidate(content[0].text);
      if (nested.response) {
        const unwrapped = unwrapNestedEnvelope(nested.response, depth + 1);
        return { ...unwrapped, repaired: nested.repaired || unwrapped.repaired };
      }
    }
    if (typeof envelope.text === "string") {
      const nested = parseCandidate(envelope.text);
      if (nested.response) {
        const unwrapped = unwrapNestedEnvelope(nested.response, depth + 1);
        return { ...unwrapped, repaired: nested.repaired || unwrapped.repaired };
      }
    }
    return { response: envelope };
  }

  const parsed = parseCandidate(raw);
  if (!parsed.response) {
    return parsed;
  }
  const unwrapped = unwrapNestedEnvelope(parsed.response, 0);
  if (!unwrapped.response) {
    return unwrapped;
  }
  return {
    ...unwrapped,
    response: applyFileBlocksToEnvelope(unwrapped.response, extractFileBlocks(raw)),
  };
}

export function parseChatWebResponse(raw: string): ChatWebResponseEnvelope | null {
  return parseChatWebResponseDetailed(raw).response;
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

function messageLikelyNeedsFileTools(context: Context): boolean {
  const hasWriteTool = Array.isArray(context.tools)
    ? context.tools.some((tool) => tool?.name === "write")
    : false;
  if (!hasWriteTool) {
    return false;
  }
  const lastUserMessage = [...context.messages]
    .toReversed()
    .find((message) => message.role === "user");
  if (!lastUserMessage || typeof lastUserMessage.content !== "string") {
    return false;
  }
  return /(write|save|create|archivo|guardar|guarda|crear|file|files)/i.test(
    lastUserMessage.content,
  );
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
    const partial = makeChatWebAssistantMessage(startedAt);
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
        let parsedResult = parseChatWebResponseDetailed(rawResponse);
        if (!parsedResult.response) {
          const retryPrompt = firstRawResponse.trim()
            ? buildRepairPrompt(firstRawResponse, parsedResult.error)
            : buildEmptyRetryPrompt(prompt);
          const repairedRawResponse =
            (await sendMessage({
              conversationId,
              message: retryPrompt,
              aiAssistant: params.aiAssistant,
              browserType: params.browserType,
            })) ?? "";
          if (repairedRawResponse.trim()) {
            rawResponse = repairedRawResponse;
            parsedResult = parseChatWebResponseDetailed(repairedRawResponse);
          }
        }
        if (parsedResult.response) {
          const normalized = normalizeContentBlocks(parsedResult.response.content);
          const hasToolCall = normalized.some((block) => block.type === "toolCall");
          if (
            !hasToolCall &&
            parsedResult.response.stopReason === "stop" &&
            messageLikelyNeedsFileTools(context)
          ) {
            const toolUseRetryPrompt = buildToolUseRetryPrompt({
              originalPrompt: prompt,
              previousResponse: rawResponse,
            });
            const toolUseRetryRaw =
              (await sendMessage({
                conversationId,
                message: toolUseRetryPrompt,
                aiAssistant: params.aiAssistant,
                browserType: params.browserType,
              })) ?? "";
            if (toolUseRetryRaw.trim()) {
              rawResponse = toolUseRetryRaw;
              parsedResult = parseChatWebResponseDetailed(toolUseRetryRaw);
            }
          }
        }
        const parsed = parsedResult.response;
        const message = makeChatWebAssistantMessage(now());

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
        const message = makeChatWebAssistantMessage(now());
        message.stopReason = "error";
        message.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: "error", reason: "error", error: message });
        stream.end(message);
      }
    })();

    return stream;
  };
}

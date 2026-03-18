import type { Context, Model } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
  buildChatWebAgentPrompt,
  createChatWebStreamFn,
  parseChatWebResponse,
} from "./chatweb-stream.js";

describe("chatweb-stream", () => {
  it("builds a prompt that preserves the system message, messages, and tool schemas", () => {
    const prompt = buildChatWebAgentPrompt({
      context: {
        systemPrompt: "You are OpenClaw.",
        messages: [{ role: "user", content: "hola", timestamp: 1 }],
        tools: [
          {
            name: "write",
            description: "Write a file",
            parameters: Type.Object({ path: Type.String() }),
          },
        ],
      },
    });

    expect(prompt).toContain('"role": "system"');
    expect(prompt).toContain("You are OpenClaw.");
    expect(prompt).toContain('"name": "write"');
    expect(prompt).toContain('"role": "user"');
    expect(prompt).toContain('"hola"');
  });

  it("keeps full system prompt, history, and tool schemas in the browser payload", () => {
    const prompt = buildChatWebAgentPrompt({
      context: {
        systemPrompt: "SYSTEM_FULL",
        messages: [{ role: "user", content: "mensaje completo", timestamp: 1 }],
        tools: [
          {
            name: "write",
            description: "Write a file",
            parameters: Type.Object({
              file_path: Type.String({ description: "absolute path" }),
              content: Type.String({ description: "file contents" }),
            }),
          },
        ],
      },
    });

    expect(prompt).toContain("SYSTEM_FULL");
    expect(prompt).toContain("mensaje completo");
    expect(prompt).toContain('"file_path"');
    expect(prompt).toContain('"description": "absolute path"');
    expect(prompt).toContain('"stopReason": "stop | toolUse"');
    expect(prompt).toContain("Start with { and end with }.");
  });

  it("parses fenced JSON responses", () => {
    const parsed = parseChatWebResponse(
      '```json\n{"toolCalls":[{"name":"write","arguments":{"file_path":"a.txt"}}]}\n```',
    );

    expect(parsed?.toolCalls?.[0]?.name).toBe("write");
    expect(parsed?.toolCalls?.[0]?.arguments).toEqual({ file_path: "a.txt" });
  });

  it("unwraps nested JSON encoded inside a text block", () => {
    const nested = JSON.stringify({
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "call_1", name: "write", arguments: { file_path: "a.txt" } },
      ],
    });
    const parsed = parseChatWebResponse(
      JSON.stringify({
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: nested }],
      }),
    );

    expect(parsed?.stopReason).toBe("toolUse");
    expect(parsed?.content?.[0]).toEqual({
      type: "toolCall",
      id: "call_1",
      name: "write",
      arguments: { file_path: "a.txt" },
    });
  });

  it("emits toolUse when the browser assistant returns assistant content blocks", async () => {
    const streamFn = createChatWebStreamFn({
      aiAssistant: "chatgpt",
      browserType: "chrome",
      deps: {
        sendMessage: async () =>
          JSON.stringify({
            role: "assistant",
            stopReason: "toolUse",
            content: [
              { type: "thinking", thinking: "voy a escribir el archivo" },
              { type: "toolCall", id: "call_1", name: "write", arguments: { file_path: "a.txt" } },
            ],
          }),
        now: () => 123,
      },
    });

    const model = {
      id: "test-model",
      name: "Test Model",
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://example.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1,
      maxTokens: 1,
    } satisfies Model<"openai-completions">;
    const context: Context = {
      messages: [{ role: "user", content: "crea un archivo", timestamp: 1 }],
    };

    const message = await streamFn(model, context).result();

    expect(message.stopReason).toBe("toolUse");
    expect(message.content).toContainEqual({
      type: "thinking",
      thinking: "voy a escribir el archivo",
    });
    expect(message.content).toContainEqual({
      type: "toolCall",
      id: "call_1",
      name: "write",
      arguments: { file_path: "a.txt" },
    });
  });

  it("falls back to plain text when the browser assistant returns non-JSON text", async () => {
    const streamFn = createChatWebStreamFn({
      aiAssistant: "chatgpt",
      browserType: "chrome",
      deps: { sendMessage: async () => "respuesta final" },
    });

    const model = {
      id: "test-model",
      name: "Test Model",
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://example.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1,
      maxTokens: 1,
    } satisfies Model<"openai-completions">;

    const message = await streamFn(model, { messages: [] }).result();

    expect(message.stopReason).toBe("stop");
    expect(message.content).toContainEqual({ type: "text", text: "respuesta final" });
  });

  it("retries once with a repair prompt when the first browser response is not JSON", async () => {
    const prompts: string[] = [];
    const streamFn = createChatWebStreamFn({
      aiAssistant: "chatgpt",
      browserType: "chrome",
      deps: {
        sendMessage: async ({ message }) => {
          prompts.push(message);
          if (prompts.length === 1) {
            return "Te dejo los archivos HTML, CSS y JS directamente...";
          }
          return JSON.stringify({
            role: "assistant",
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "call_1",
                name: "write",
                arguments: {
                  file_path: "F:\\\\workspace_sonny\\\\index.html",
                  content: "<html />",
                },
              },
            ],
          });
        },
      },
    });

    const model = {
      id: "test-model",
      name: "Test Model",
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://example.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1,
      maxTokens: 1,
    } satisfies Model<"openai-completions">;

    const message = await streamFn(model, { messages: [] }).result();

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(
      "Convert that previous answer into exactly one valid JSON object only.",
    );
    expect(message.stopReason).toBe("toolUse");
    expect(message.model).toBe("chatweb-browser");
    expect(message.provider).toBe("chatweb");
    expect(message.content).toContainEqual({
      type: "toolCall",
      id: "call_1",
      name: "write",
      arguments: { file_path: "F:\\\\workspace_sonny\\\\index.html", content: "<html />" },
    });
  });

  it("retries with the original task when the first browser response is empty", async () => {
    const prompts: string[] = [];
    const streamFn = createChatWebStreamFn({
      aiAssistant: "chatgpt",
      browserType: "chrome",
      deps: {
        sendMessage: async ({ message }) => {
          prompts.push(message);
          if (prompts.length === 1) {
            return "";
          }
          return '{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"ok"}]}';
        },
      },
    });

    const model = {
      id: "openrouter/arcee-ai/trinity-mini:free",
      name: "Test Model",
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://example.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1,
      maxTokens: 1,
    } satisfies Model<"openai-completions">;

    const message = await streamFn(model, { messages: [] }).result();

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Your previous response was empty.");
    expect(prompts[1]).toContain("Original task payload:");
    expect(prompts[1]).not.toContain(
      "Convert that previous answer into exactly one valid JSON object only.",
    );
    expect(message.stopReason).toBe("stop");
    expect(message.model).toBe("chatweb-browser");
    expect(message.provider).toBe("chatweb");
    expect(message.content).toContainEqual({ type: "text", text: "ok" });
  });

  it("executes toolUse when retry returns JSON wrapped inside text", async () => {
    const streamFn = createChatWebStreamFn({
      aiAssistant: "chatgpt",
      browserType: "chrome",
      deps: {
        sendMessage: async ({ message }) => {
          if (message.includes("Original task payload:")) {
            const nested = JSON.stringify({
              role: "assistant",
              stopReason: "toolUse",
              content: [
                {
                  type: "toolCall",
                  id: "call_wrapped",
                  name: "write",
                  arguments: {
                    file_path: "F:\\\\workspace_sonny\\\\index.html",
                    content: "<html />",
                  },
                },
              ],
            });
            return JSON.stringify({
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: nested }],
            });
          }
          return "";
        },
      },
    });

    const model = {
      id: "openrouter/arcee-ai/trinity-mini:free",
      name: "Test Model",
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://example.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1,
      maxTokens: 1,
    } satisfies Model<"openai-completions">;

    const message = await streamFn(model, { messages: [] }).result();

    expect(message.stopReason).toBe("toolUse");
    expect(message.content).toContainEqual({
      type: "toolCall",
      id: "call_wrapped",
      name: "write",
      arguments: { file_path: "F:\\\\workspace_sonny\\\\index.html", content: "<html />" },
    });
  });
});

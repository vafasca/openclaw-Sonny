import type { Context, Model } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
  buildChatWebAgentPrompt,
  createChatWebStreamFn,
  parseChatWebResponse,
  parseChatWebResponseDetailed,
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

    expect(prompt).toContain('System message:\n{"role":"system","content":""}');
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

    expect(prompt).not.toContain("SYSTEM_FULL");
    expect(prompt).toContain("mensaje completo");
    expect(prompt).toContain('"file_path"');
    expect(prompt).toContain('"description": "absolute path"');
    expect(prompt).toContain('"stopReason": "stop | toolUse"');
    expect(prompt).toContain("Start with { and end with }.");
    expect(prompt).toContain("CRITICAL RULE — FILE OPERATIONS:");
    expect(prompt).toContain(
      "REQUIRED FILE-CONTENT FORMAT (MANDATORY for HTML/CSS/JS file writes):",
    );
    expect(prompt).toContain('{"content":"<<FILE:index_html>>"}');
    expect(prompt).toContain("escape backslashes (example: F:\\\\workspace_sonny\\\\index.html)");
    expect(prompt).toContain("<<FILE:index_html>>");
  });

  it("builds a slim prompt with essential tools and condensed history", () => {
    const prompt = buildChatWebAgentPrompt({
      context: {
        systemPrompt: "General system instructions\nWorkspace: /tmp/demo-workspace\nOther notes",
        messages: [
          { role: "user", content: "turn 1", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "turn 2" }], timestamp: 2 },
          { role: "user", content: "turn 3", timestamp: 3 },
          { role: "assistant", content: [{ type: "text", text: "turn 4" }], timestamp: 4 },
          { role: "user", content: "turn 5", timestamp: 5 },
          { role: "assistant", content: [{ type: "text", text: "turn 6" }], timestamp: 6 },
        ],
        tools: [
          { name: "write", description: "Write file", parameters: Type.Object({}) },
          { name: "search", description: "Search web", parameters: Type.Object({}) },
          { name: "process", description: "Process manager", parameters: Type.Object({}) },
        ],
      },
    });

    expect(prompt).toContain("Workspace context:");
    expect(prompt).toContain("/tmp/demo-workspace");
    expect(prompt).toContain('"name": "write"');
    expect(prompt).toContain('"name": "process"');
    expect(prompt).not.toContain('"name": "search"');
    expect(prompt).toContain("Earlier context summary:");
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

  it("replaces file placeholders using delimited file blocks outside JSON", () => {
    const raw = `{
      "role":"assistant",
      "stopReason":"toolUse",
      "content":[
        {
          "type":"toolCall",
          "id":"call_1",
          "name":"write",
          "arguments":{"file_path":"F:\\\\workspace_sonny\\\\index.html","content":"<<FILE:index_html>>"}
        }
      ]
    }

<FILE:index_html>
<!DOCTYPE html>
<html lang="es">
  <body>ok</body>
</html>
<END_FILE:index_html>`;
    const parsed = parseChatWebResponseDetailed(raw);
    const toolCall = parsed.response?.content?.[0];

    expect(toolCall?.type).toBe("toolCall");
    expect(toolCall?.arguments).toEqual({
      file_path: "F:\\workspace_sonny\\index.html",
      content: '<!DOCTYPE html>\n<html lang="es">\n  <body>ok</body>\n</html>',
    });
  });

  it("handles END_FILE on same line as last content line", () => {
    const raw = `{"role":"assistant","stopReason":"toolUse","content":[{"type":"toolCall","id":"c1","name":"write","arguments":{"path":"a.html","content":"<<FILE:index_html>>"}}]}

<<FILE:index_html>>
<!DOCTYPE html><html lang="es"></html> <<END_FILE:index_html>>`;
    const parsed = parseChatWebResponseDetailed(raw);
    const toolCall = parsed.response?.content?.[0];
    expect(toolCall?.type).toBe("toolCall");
    expect(toolCall?.arguments).toEqual({
      path: "a.html",
      content: '<!DOCTYPE html><html lang="es"></html>',
    });
  });

  it("extracts file blocks when END_FILE follows content without a newline", () => {
    const raw =
      '{"role":"assistant","stopReason":"toolUse","content":[{"type":"toolCall","id":"c1","name":"write","arguments":{"path":"one-line.html","content":"<<FILE:index_html>>"}}]}\n\n<<FILE:index_html>><h1>hola</h1><<END_FILE:index_html>>';
    const parsed = parseChatWebResponseDetailed(raw);
    const toolCall = parsed.response?.content?.[0];
    expect(toolCall?.type).toBe("toolCall");
    expect(toolCall?.arguments).toEqual({
      path: "one-line.html",
      content: "<h1>hola</h1>",
    });
  });

  it("extracts the root JSON only even when appended file blocks contain braces", () => {
    const raw = `{
      "role":"assistant",
      "stopReason":"toolUse",
      "content":[
        {
          "type":"toolCall",
          "id":"call_js",
          "name":"write",
          "arguments":{"file_path":"F:\\\\workspace_sonny\\\\script.js","content":"<<FILE:script_js>>"}
        }
      ]
    }

<<FILE:script_js>>
function run() {
  console.log("ok");
});
<<END_FILE:script_js>>`;
    const parsed = parseChatWebResponseDetailed(raw);
    const toolCall = parsed.response?.content?.[0];

    expect(toolCall?.type).toBe("toolCall");
    expect(toolCall?.arguments).toEqual({
      file_path: "F:\\workspace_sonny\\script.js",
      content: 'function run() {\n  console.log("ok");\n});',
    });
  });

  it("normalizes single-bracket FILE blocks so placeholder substitution still works", () => {
    const raw = `{
      "role":"assistant",
      "stopReason":"toolUse",
      "content":[
        {
          "type":"toolCall",
          "id":"call_1",
          "name":"write",
          "arguments":{"file_path":"F:\\\\workspace_sonny\\\\index.html","content":"<<FILE:index_html>>"}
        }
      ]
    }

<FILE:index_html>
<h1>Hola</h1>
<END_FILE:index_html>`;
    const parsed = parseChatWebResponseDetailed(raw);
    const toolCall = parsed.response?.content?.[0];
    expect(toolCall?.type).toBe("toolCall");
    expect(toolCall?.arguments).toEqual({
      file_path: "F:\\workspace_sonny\\index.html",
      content: "<h1>Hola</h1>",
    });
  });

  it("sanitizes newlines accidentally inserted inside css url() strings", () => {
    const raw = `{
      "role":"assistant",
      "stopReason":"toolUse",
      "content":[
        {
          "type":"toolCall",
          "id":"call_css",
          "name":"write",
          "arguments":{"file_path":"F:\\\\workspace_sonny\\\\styles.css","content":"<<FILE:styles_css>>"}
        }
      ]
    }

<<FILE:styles_css>>
body { background: url('https://i.imgur.com/5WQZ6Vn.png
'); }
<<END_FILE:styles_css>>`;
    const parsed = parseChatWebResponseDetailed(raw);
    const toolCall = parsed.response?.content?.[0];
    expect(toolCall?.type).toBe("toolCall");
    expect(toolCall?.arguments).toEqual({
      file_path: "F:\\workspace_sonny\\styles.css",
      content: "body { background: url('https://i.imgur.com/5WQZ6Vn.png'); }",
    });
  });

  it("sanitizes css url() newlines when css is inline in tool arguments", async () => {
    const streamFn = createChatWebStreamFn({
      aiAssistant: "chatgpt",
      browserType: "chrome",
      deps: {
        sendMessage: async () =>
          JSON.stringify({
            role: "assistant",
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "call_css_inline",
                name: "write",
                arguments: {
                  file_path: "F:\\\\workspace_sonny\\\\styles.css",
                  content: "body { background: url('https://i.imgur.com/5WQZ6Vn.png\n'); }",
                },
              },
            ],
          }),
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
    expect(message.content).toContainEqual({
      type: "toolCall",
      id: "call_css_inline",
      name: "write",
      arguments: {
        file_path: "F:\\\\workspace_sonny\\\\styles.css",
        content: "body { background: url('https://i.imgur.com/5WQZ6Vn.png'); }",
      },
    });
  });

  it("repairs malformed placeholder newlines and single-backslash windows paths", () => {
    const raw = `{
      "role":"assistant",
      "stopReason":"toolUse",
      "content":[
        {
          "type":"toolCall",
          "id":"call_1",
          "name":"write",
          "arguments":{"file_path":"F:\\workspace_sonny\\index.html","content":"<FILE:index_html
>"}
        }
      ]
    }

<<FILE:index_html>>
<!DOCTYPE html>
<html lang="es">
  <body>ok</body>
</html>
<<END_FILE:index_html>>`;
    const parsed = parseChatWebResponseDetailed(raw);
    const toolCall = parsed.response?.content?.[0];

    expect(toolCall?.type).toBe("toolCall");
    expect(toolCall?.arguments).toEqual({
      file_path: "F:\\workspace_sonny\\index.html",
      content: '<!DOCTYPE html>\n<html lang="es">\n  <body>ok</body>\n</html>',
    });
  });

  it("repairs common unescaped quote JSON failures", () => {
    const broken = `{
      "role":"assistant",
      "stopReason":"toolUse",
      "content":[{"type":"toolCall","id":"call_1","name":"write","arguments":{"content":"<html lang="es">"}}]
    }`;
    const parsed = parseChatWebResponseDetailed(broken);

    expect(parsed.response?.stopReason).toBe("toolUse");
    const firstBlock = parsed.response?.content?.[0];
    expect(firstBlock?.type).toBe("toolCall");
    expect(firstBlock?.arguments).toEqual({ content: '<html lang="es">' });
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

  it("normalizes tool-like blocks that use non-toolCall type names", async () => {
    const streamFn = createChatWebStreamFn({
      aiAssistant: "chatgpt",
      browserType: "chrome",
      deps: {
        sendMessage: async () =>
          JSON.stringify({
            role: "assistant",
            stopReason: "toolUse",
            content: [
              { type: "thinking", thinking: "polling process..." },
              {
                type: "process",
                id: "poll_angular_creation",
                name: "process",
                arguments: { action: "poll", sessionId: "create_angular_project", timeout: 60000 },
              },
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
      messages: [{ role: "user", content: "sigue creando el proyecto", timestamp: 1 }],
    };

    const message = await streamFn(model, context).result();

    expect(message.stopReason).toBe("toolUse");
    expect(message.content).toContainEqual({
      type: "toolCall",
      id: "poll_angular_creation",
      name: "process",
      arguments: { action: "poll", sessionId: "create_angular_project", timeout: 60000 },
    });
  });

  it("uses a unique chatweb conversation id per run", async () => {
    const conversationIds: string[] = [];
    const streamFn = createChatWebStreamFn({
      aiAssistant: "chatgpt",
      browserType: "chrome",
      deps: {
        sendMessage: async ({ conversationId }) => {
          conversationIds.push(conversationId);
          return JSON.stringify({
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "ok" }],
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

    await streamFn(model, { messages: [] }, { sessionId: "agent:main:main" }).result();
    await streamFn(model, { messages: [] }, { sessionId: "agent:main:main" }).result();

    expect(conversationIds).toHaveLength(2);
    expect(conversationIds[0]).not.toEqual(conversationIds[1]);
    expect(conversationIds[0]).toContain("agent:main:main:run:");
    expect(conversationIds[1]).toContain("agent:main:main:run:");
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
    expect(prompts[1]).toContain("Parse error:");
    expect(prompts[1]).toContain("use REQUIRED file placeholders instead of inline code strings.");
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

  it("retries with toolUse instructions when file task returns stop text without toolCalls", async () => {
    const prompts: string[] = [];
    const streamFn = createChatWebStreamFn({
      aiAssistant: "chatgpt",
      browserType: "chrome",
      deps: {
        sendMessage: async ({ message }) => {
          prompts.push(message);
          if (prompts.length === 1) {
            return JSON.stringify({
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: "No pude escribir archivos." }],
            });
          }
          return JSON.stringify({
            role: "assistant",
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "call_retry",
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
    const context: Context = {
      messages: [{ role: "user", content: "crea y guarda un archivo html", timestamp: 1 }],
      tools: [{ name: "write", description: "Write file", parameters: Type.Object({}) }],
    };

    const message = await streamFn(model, context).result();

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('You MUST return toolCall blocks using the "write" tool');
    expect(message.stopReason).toBe("toolUse");
    expect(message.content).toContainEqual({
      type: "toolCall",
      id: "call_retry",
      name: "write",
      arguments: { file_path: "F:\\\\workspace_sonny\\\\index.html", content: "<html />" },
    });
  });
});

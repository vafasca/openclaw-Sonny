# Prompt format used for API-key model requests

This document explains how OpenClaw converts incoming API requests into the **actual prompt text** that is sent into the agent/model pipeline.

## 1) Where API-key provider config lives

Model provider API keys are configured in `models.providers.<provider>.apiKey` (schema: `ModelProviderSchema`).

```yaml
models:
  providers:
    openai:
      baseUrl: https://api.openai.com/v1
      apiKey: ${OPENAI_API_KEY}
      models:
        - id: gpt-5-mini
```

Relevant schema location: `src/config/zod-schema.core.ts`.

## 2) OpenAI-compatible endpoint (`/v1/chat/completions`)

Incoming `messages[]` are transformed by `buildAgentPrompt(...)` in `src/gateway/openai-http.ts`.

### Input you send

- `role: system|developer` messages are **not treated as chat turns**.
- `role: user|assistant|function/tool` become conversation entries.

### Internal transformation

- `system` + `developer` contents are concatenated into `extraSystemPrompt`.
- Conversation history is flattened into text lines like `User: ...`, `Assistant: ...`, `Tool: ...`.
- The final text prompt is built with history markers:
  - `[Chat messages since your last reply - for context]`
  - `[Current message - respond to this]`
- The model is expected to respond to the **current message marker** section.

So a user input such as `"desarrolla un login"` is sent as the current message (with prior turns as context), not as raw JSON.

## 3) OpenAI Responses-compatible endpoint (`/v1/responses`)

Incoming `input` is transformed in `src/gateway/openresponses-prompt.ts`.

### Input you send

- `type: "message"` with `role: system|developer|user|assistant`
- optional `function_call_output`

### Internal transformation

- `system/developer` text becomes `extraSystemPrompt`.
- `user/assistant/tool` messages are converted to the same history+current-message text format.
- Final `extraSystemPrompt` may also include:
  - `payload.instructions`
  - tool-choice enforcement prompts
  - file context extracted from `input_file`/`image_url`

## 4) How responses are returned

### `/v1/chat/completions`

- OpenClaw returns:
  - `choices[0].message.role = "assistant"`
  - `choices[0].message.content = <joined assistant text>`

### `/v1/responses`

- Non-stream: `output[0].content[0].text`-style assistant output item.
- Stream: SSE events (`response.output_text.delta`, `response.completed`, etc.).

## 5) Practical request format recommendation

If your goal is: **"desarrolla un login"**, send it as the latest `user` message.

### For `/v1/chat/completions`

```json
{
  "model": "openclaw",
  "messages": [
    { "role": "system", "content": "Eres un asistente técnico. Responde en español." },
    { "role": "user", "content": "Desarrolla un login con Node.js y JWT" }
  ]
}
```

### For `/v1/responses`

```json
{
  "model": "openclaw",
  "input": [
    {
      "type": "message",
      "role": "system",
      "content": [
        { "type": "input_text", "text": "Eres un asistente técnico. Responde en español." }
      ]
    },
    {
      "type": "message",
      "role": "user",
      "content": [{ "type": "input_text", "text": "Desarrolla un login con Node.js y JWT" }]
    }
  ]
}
```

## 6) Common failure causes

- Missing last user message (`Missing user message in messages/input`).
- Sending only `system`/`developer` without a user turn.
- Wrong content shape (especially in `input[]` multimodal objects).
- Assuming raw prior JSON is forwarded to model. OpenClaw rewrites to history+current-message text format first.

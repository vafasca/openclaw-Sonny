import { describe, expect, it } from "vitest";
import { assertRequiredParams, CLAUDE_PARAM_GROUPS } from "./pi-tools.params.js";

describe("CLAUDE_PARAM_GROUPS.write", () => {
  it("accepts empty-string content so models can create empty files", () => {
    expect(() =>
      assertRequiredParams(
        {
          path: "F:\\workspace_sonny\\hola.txt",
          content: "",
        },
        CLAUDE_PARAM_GROUPS.write,
        "write",
      ),
    ).not.toThrow();
  });

  it("still rejects missing content", () => {
    expect(() =>
      assertRequiredParams(
        {
          path: "F:\\workspace_sonny\\hola.txt",
        },
        CLAUDE_PARAM_GROUPS.write,
        "write",
      ),
    ).toThrow(/Missing required parameter: content/);
  });
});

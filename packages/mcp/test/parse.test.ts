import { describe, expect, it } from "vitest";
import { parseToolResult } from "../src/index";

describe("parseToolResult", () => {
  it("unwraps JSON payloads from MCP text content", () => {
    const result = parseToolResult({
      content: [{ type: "text", text: '{"result":[{"id":"m1","content":"fact"}]}' }],
    });
    expect(result).toEqual({ result: [{ id: "m1", content: "fact" }] });
  });

  it("returns plain text when the payload is not JSON", () => {
    expect(parseToolResult({ content: [{ type: "text", text: "## Memory block" }] })).toBe("## Memory block");
  });

  it("passes through results without text content", () => {
    const raw = { content: [{ type: "image" }] };
    expect(parseToolResult(raw)).toBe(raw);
    expect(parseToolResult(undefined)).toBeUndefined();
  });
});

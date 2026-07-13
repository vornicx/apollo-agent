import { describe, expect, it } from "vitest";
import { redactSecrets, redactText } from "../src/index";

describe("secret redaction", () => {
  it("redacts common credential shapes from free text", () => {
    expect(redactText("token sk-abcdefghijklmnopqrstuvwxyz123456")).toBe("token [REDACTED]");
  });

  it("redacts values under credential-like keys recursively", () => {
    expect(redactSecrets({ nested: { apiKey: "plain-value", safe: "visible" } })).toEqual({
      nested: { apiKey: "[REDACTED]", safe: "visible" },
    });
  });
});

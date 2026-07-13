import { describe, expect, it } from "vitest";
import { parseProtocol } from "../src/index";

describe("parseProtocol", () => {
  it("extracts intents, beliefs, questions, and step transitions", () => {
    const text = [
      "INTENT: create the file",
      "Some prose in between.",
      "BELIEF[test_cmd]: node sum.test.js",
      "BELIEF[lang]: javascript",
      "QUESTION: which node version?",
      "STEP_DONE[s1]: wrote sum.js and its test",
    ].join("\n");
    const p = parseProtocol(text);
    expect(p.intents).toEqual(["create the file"]);
    expect(p.beliefs).toEqual([
      { key: "test_cmd", value: "node sum.test.js" },
      { key: "lang", value: "javascript" },
    ]);
    expect(p.questions).toEqual(["which node version?"]);
    expect(p.done).toEqual([{ id: "s1", note: "wrote sum.js and its test" }]);
    expect(p.failed).toEqual([]);
  });

  it("captures failures and tolerates empty input", () => {
    expect(parseProtocol("STEP_FAILED[s2]: dependency missing").failed).toEqual([{ id: "s2", note: "dependency missing" }]);
    expect(parseProtocol("")).toEqual({ intents: [], beliefs: [], questions: [], done: [], failed: [] });
  });
});

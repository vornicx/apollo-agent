import { describe, expect, it } from "vitest";
import { inferTaskKind, localInstantReply, selectDepth } from "../src/depth";

describe("adaptive depth selector", () => {
  it("keeps unmistakable small talk on the instant lane", () => {
    expect(selectDepth("hola")).toMatchObject({ depth: "instant", kind: "conversation" });
    expect(localInstantReply("hola")).toBe("¡Hola! ¿En qué puedo ayudarte?");
    expect(localInstantReply("hello!")).toBe("Hello! How can I help?");
    expect(localInstantReply("hola, explícame Apollo")).toBeUndefined();
  });

  it("uses one agent for ordinary work", () => {
    expect(selectDepth("Corrige el error del formulario")).toMatchObject({ depth: "agent", kind: "debugging" });
  });

  it("reserves the full cycle for risky or long-horizon work", () => {
    expect(selectDepth("Audita la seguridad y prepara el despliegue a producción").depth).toBe("deep");
    expect(selectDepth("x".repeat(1_501)).depth).toBe("deep");
  });

  it("honors explicit caller control", () => {
    expect(selectDepth("hola", "deep")).toMatchObject({ depth: "deep", reason: expect.stringContaining("forced") });
  });

  it("classifies the task kind without a model call", () => {
    expect(inferTaskKind("Investiga y compara estas fuentes")).toBe("research");
    expect(inferTaskKind("Implementa las pruebas")).toBe("code-generation");
  });
});

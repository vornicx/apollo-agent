import type { TaskKind } from "@archic/apollo-router";

export type CortexDepth = "auto" | "instant" | "agent" | "deep";
export type ResolvedCortexDepth = Exclude<CortexDepth, "auto">;

export interface DepthDecision {
  depth: ResolvedCortexDepth;
  reason: string;
  kind: TaskKind;
}

const INSTANT = [
  /^(hola|hello|hi|hey|buenas|buenos d[iías]|buenas tardes|buenas noches)[!.?\s]*$/iu,
  /^(gracias|thanks|thank you|vale|ok|okay|perfecto|genial)[!.?\s]*$/iu,
  /^(adi[oó]s|bye|hasta luego)[!.?\s]*$/iu,
];

const DEEP = /\b(audit|audita|security|seguridad|architecture|arquitectura|migrat|release|deploy|desplieg|delete|deletion|borrar|eliminar|drop|reset|sobrescrib|investiga a fondo|deep research|amenaza|threat model|incident|incidente|producci[oó]n|base de datos|database schema|breaking change)\b/iu;

/** Exact small talk that needs neither a provider nor user context. */
export function localInstantReply(goal: string): string | undefined {
  const text = goal.trim();
  if (/^(hola|buenas|buenos d[iías]|buenas tardes|buenas noches)[!.?\s]*$/iu.test(text)) {
    return "¡Hola! ¿En qué puedo ayudarte?";
  }
  if (/^(hello|hi|hey)[!.?\s]*$/iu.test(text)) return "Hello! How can I help?";
  if (/^gracias[!.?\s]*$/iu.test(text)) return "¡De nada!";
  if (/^(vale|perfecto|genial)[!.?\s]*$/iu.test(text)) return "¡Perfecto!";
  if (/^(thanks|thank you)[!.?\s]*$/iu.test(text)) return "You're welcome!";
  if (/^(ok|okay)[!.?\s]*$/iu.test(text)) return "Okay!";
  if (/^(adi[oó]s|hasta luego)[!.?\s]*$/iu.test(text)) return "¡Hasta luego!";
  if (/^bye[!.?\s]*$/iu.test(text)) return "Goodbye!";
  return undefined;
}

/**
 * Cheap, deterministic depth selection. It is intentionally conservative:
 * only unmistakable small talk skips tools, while high-risk or long-horizon
 * work gets the full cognitive cycle. Everything else uses one capable agent.
 */
export function selectDepth(goal: string, requested: CortexDepth = "auto"): DepthDecision {
  const text = goal.trim();
  const kind = inferTaskKind(text);
  if (requested !== "auto") return { depth: requested, reason: `forced by caller (--depth ${requested})`, kind };
  if (INSTANT.some((pattern) => pattern.test(text))) {
    return { depth: "instant", reason: "deterministic small-talk fast path", kind: "conversation" };
  }
  if (text.length > 1_500) return { depth: "deep", reason: "long-horizon goal (>1500 characters)", kind };
  if (DEEP.test(text)) return { depth: "deep", reason: "high-risk or architecture/research signal", kind };
  return { depth: "agent", reason: "single-agent path with deterministic post-execution evidence", kind };
}

export function inferTaskKind(goal: string): TaskKind {
  if (/\b(debug|diagnos|fix|corrige|repara|error|bug|falla)\b/iu.test(goal)) return "debugging";
  if (/\b(refactor|refactoriza|reorganiza)\b/iu.test(goal)) return "refactoring";
  if (/\b(review|revisa|audita|code review)\b/iu.test(goal)) return "code-review";
  if (/\b(research|investiga|busca|compara|analiza fuentes)\b/iu.test(goal)) return "research";
  if (/\b(resume|summari[sz]e|resumen)\b/iu.test(goal)) return "summarization";
  if (/\b(escribe|redacta|write|draft|copy)\b/iu.test(goal)) return "writing";
  if (/\b(extrae|extract|parsea)\b/iu.test(goal)) return "extraction";
  if (/\b(crea|implementa|build|code|c[oó]digo|archivo|file|test)\b/iu.test(goal)) return "code-generation";
  return "conversation";
}

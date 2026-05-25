/**
 * Apollo Mission Router — Groq Semantic Engine
 * ──────────────────────────────────────────────
 * Reemplaza el clasificador de keywords por un modelo semántico real.
 * Gratuito: Groq free tier (6000 req/día, ~200 tokens/s).
 *
 * Compatibilidad total con la interfaz original:
 *   - estimateMission(goal) → MissionEstimate  [síncrona, usa keywords como fallback]
 *   - estimateMissionSemantic(goal) → Promise<MissionEstimate>  [nueva, usa Groq]
 *
 * Integración en stream.ts: reemplaza estimateMission por estimateMissionSemantic.
 */

// ── Tipos públicos (sin cambios — compatibilidad total) ──────────────────────

export type MissionComplexity = "simple" | "standard" | "complex" | "critical";

export type MissionTemplate = {
  id: string;
  title: string;
  shortGoal: string;
  goal: string;
  complexity: MissionComplexity;
  timeSaved: string;
};

export type MissionEstimate = {
  complexity: MissionComplexity;
  score: number;
  route: string;
  agents: string[];
  budget: string;
  confidence: number;
  risk: "low" | "medium" | "high";
  // Nuevos campos opcionales (sin romper código existente)
  intent?: string;
  reasoning?: string;
  latency_ms?: number;
  via?: "semantic" | "keywords";
};

// ── Templates (sin cambios) ──────────────────────────────────────────────────

export const MISSION_TEMPLATES: MissionTemplate[] = [
  {
    id: "saas-builder",
    title: "SaaS Builder",
    shortGoal: "Turn an idea into a launchable SaaS MVP.",
    goal: "Build a SaaS MVP plan: define positioning, target user, core product flow, data model, landing structure, pricing, and a 7-day execution roadmap.",
    complexity: "complex",
    timeSaved: "4h",
  },
  {
    id: "competitor-research",
    title: "Competitor Research",
    shortGoal: "Map competitors, pricing, gaps and positioning.",
    goal: "Research the competitive landscape for this product. Identify direct and indirect competitors, pricing models, positioning gaps, feature patterns, risks, and a differentiated strategy.",
    complexity: "complex",
    timeSaved: "3h",
  },
  {
    id: "landing-page",
    title: "Landing Page",
    shortGoal: "Create premium landing copy and page structure.",
    goal: "Create a conversion-focused landing page plan: headline, subheadline, sections, proof points, pricing framing, CTA strategy, visual direction, and implementation checklist.",
    complexity: "standard",
    timeSaved: "2h",
  },
  {
    id: "prd",
    title: "PRD",
    shortGoal: "Convert a product idea into a buildable PRD.",
    goal: "Write a product requirements document for this idea. Include problem, users, jobs to be done, functional requirements, non-goals, acceptance criteria, risks, and release plan.",
    complexity: "standard",
    timeSaved: "3h",
  },
  {
    id: "marketing-strategy",
    title: "Marketing Strategy",
    shortGoal: "Build a focused GTM and acquisition plan.",
    goal: "Create a go-to-market strategy: ICP, positioning, channels, messaging, activation loop, retention loop, first campaigns, and success metrics.",
    complexity: "complex",
    timeSaved: "4h",
  },
  {
    id: "growth-audit",
    title: "Growth Audit",
    shortGoal: "Find leverage points in acquisition and retention.",
    goal: "Audit this business for growth opportunities. Identify acquisition bottlenecks, activation gaps, retention levers, viral loops, pricing improvements, and a prioritized action plan.",
    complexity: "complex",
    timeSaved: "5h",
  },
];

// ── Keyword engine (conservado como fallback) ────────────────────────────────

const COMPLEX_KEYWORDS = [
  "architecture",
  "arquitectura",
  "build",
  "construye",
  "implement",
  "mvp",
  "saas",
  "system",
  "sistema",
  "strategy",
  "estrategia",
  "research",
  "competitor",
  "competidor",
  "growth",
  "pricing",
  "roadmap",
];

const CRITICAL_KEYWORDS = [
  "security",
  "seguridad",
  "finance",
  "legal",
  "production",
  "produccion",
  "payment",
  "pagos",
  "auth",
  "database",
  "base de datos",
];

/** Clasificador original de keywords — conservado como fallback síncrono. */
export function estimateMission(goal: string): MissionEstimate {
  const normalized = goal.toLowerCase();
  const words = normalized.split(/\s+/).filter(Boolean).length;
  const complexHits = COMPLEX_KEYWORDS.filter((w) => normalized.includes(w)).length;
  const criticalHits = CRITICAL_KEYWORDS.filter((w) => normalized.includes(w)).length;
  const score = clamp(
    0.18 + Math.min(words / 180, 0.35) + complexHits * 0.07 + criticalHits * 0.1,
    0.12,
    0.95,
  );

  const complexity: MissionComplexity =
    criticalHits > 0 && score >= 0.62
      ? "critical"
      : score < 0.3
        ? "simple"
        : score < 0.6
          ? "standard"
          : "complex";

  return { ...complexityToEstimate(complexity, score), via: "keywords" };
}

// ── Groq Semantic Router ─────────────────────────────────────────────────────

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_ROUTER_MODEL = "llama-3.1-8b-instant"; // free tier, <200ms

const ROUTER_SYSTEM_PROMPT = `You are Apollo's mission classifier. Analyze the user's goal and return ONLY a valid JSON object.

JSON schema:
{
  "complexity": "simple" | "standard" | "complex" | "critical",
  "score": <0.10-0.95>,
  "confidence": <0.50-0.99>,
  "risk": "low" | "medium" | "high",
  "intent": "<10 words max describing what the user wants>",
  "reasoning": "<one sentence>"
}

COMPLEXITY RULES:
- simple: greetings, single Q&A, lookups, quick definitions, trivial edits
- standard: summaries, single-domain tasks, basic code, focused writing, simple plans
- complex: multi-step plans, architecture, full features, research, multi-domain analysis
- critical: security-sensitive, financial systems, production deployments, auth, legal, database migrations, payment flows

SCORE: probability the task needs premium orchestration (0.10=trivial, 0.95=maximum)
RISK: impact of getting it wrong (low=reversible, medium=some impact, high=hard to undo)

Be decisive. When uncertain between two levels, pick the lower one (cheaper by default).
Return ONLY the JSON object. No preamble, no markdown, no explanation outside the JSON.`;

/**
 * Clasificador semántico usando Groq free tier.
 * Úsalo en stream.ts en lugar de estimateMission() para mayor precisión.
 *
 * @param goal - El objetivo de la misión
 * @param groqApiKey - GROQ_API_KEY del servidor (process.env.GROQ_API_KEY)
 * @returns MissionEstimate con campos extra: intent, reasoning, latency_ms, via
 */
export async function estimateMissionSemantic(
  goal: string,
  groqApiKey: string,
): Promise<MissionEstimate> {
  if (!groqApiKey) {
    console.warn("[apollo/router] GROQ_API_KEY no configurada. Usando keywords como fallback.");
    return estimateMission(goal);
  }

  const t0 = Date.now();

  try {
    const res = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_ROUTER_MODEL,
        messages: [
          { role: "system", content: ROUTER_SYSTEM_PROMPT },
          { role: "user", content: `Mission goal: ${goal}` },
        ],
        max_tokens: 200,
        temperature: 0.1,
        response_format: { type: "json_object" },
      }),
    });

    const latency_ms = Date.now() - t0;

    if (!res.ok) {
      console.warn(`[apollo/router] Groq error ${res.status}. Fallback a keywords.`);
      return { ...estimateMission(goal), latency_ms };
    }

    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };

    const raw = body.choices?.[0]?.message?.content ?? "";
    const data = JSON.parse(raw) as {
      complexity?: string;
      score?: number;
      confidence?: number;
      risk?: string;
      intent?: string;
      reasoning?: string;
    };

    const complexity = (
      ["simple", "standard", "complex", "critical"].includes(data.complexity ?? "")
        ? data.complexity
        : "standard"
    ) as MissionComplexity;

    const score = clamp(typeof data.score === "number" ? data.score : 0.5, 0.1, 0.95);
    const confidence = clamp(
      typeof data.confidence === "number" ? data.confidence : 0.8,
      0.5,
      0.99,
    );
    const risk = (["low", "medium", "high"].includes(data.risk ?? "") ? data.risk : "medium") as
      | "low"
      | "medium"
      | "high";

    const estimate = complexityToEstimate(complexity, score);

    console.info(
      `[apollo/router] ${complexity.toUpperCase()} | score=${score.toFixed(2)} | conf=${confidence.toFixed(2)} | ${latency_ms}ms | ${data.intent ?? ""}`,
    );

    return {
      ...estimate,
      confidence,
      risk,
      intent: data.intent ?? "",
      reasoning: data.reasoning ?? "",
      latency_ms,
      via: "semantic",
    };
  } catch (err) {
    const latency_ms = Date.now() - t0;
    console.warn(`[apollo/router] Error semántico (${err}). Fallback a keywords.`);
    return { ...estimateMission(goal), latency_ms };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function complexityToEstimate(
  complexity: MissionComplexity,
  score: number,
): Omit<MissionEstimate, "via"> {
  switch (complexity) {
    case "simple":
      return {
        complexity,
        score,
        route: "Free route",
        agents: ["Qwen"],
        budget: "near zero",
        confidence: 0.86,
        risk: "low",
      };
    case "standard":
      return {
        complexity,
        score,
        route: "Single premium",
        agents: ["Implementer"],
        budget: "low",
        confidence: 0.82,
        risk: "medium",
      };
    case "critical":
      return {
        complexity,
        score,
        route: "Consensus + mandatory review",
        agents: ["Planner", "Implementer", "Reviewer"],
        budget: "guarded",
        confidence: 0.74,
        risk: "high",
      };
    default: // complex
      return {
        complexity,
        score,
        route: "Full orchestration",
        agents: ["Planner", "Implementer", "Reviewer"],
        budget: "controlled",
        confidence: 0.78,
        risk: "medium",
      };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

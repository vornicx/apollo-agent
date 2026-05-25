export function estimateMission(goal) {
  const normalized = goal.toLowerCase();
  const words = normalized.split(/\s+/).filter(Boolean).length;
  const complexHits = [
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
    "code",
    "repo",
    "refactor",
  ].filter((word) => normalized.includes(word)).length;
  const criticalHits = [
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
    "migration",
  ].filter((word) => normalized.includes(word)).length;
  const score = clamp(
    0.18 + Math.min(words / 180, 0.35) + complexHits * 0.07 + criticalHits * 0.1,
    0.12,
    0.95,
  );
  const complexity =
    criticalHits > 0 && score >= 0.62
      ? "critical"
      : score < 0.3
        ? "simple"
        : score < 0.6
          ? "standard"
          : "complex";
  return complexityToEstimate(complexity, score);
}

export async function estimateMissionSemantic(goal, groqApiKey) {
  if (!groqApiKey) return { ...estimateMission(goal), via: "keywords" };
  const started = Date.now();
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [
          {
            role: "system",
            content:
              'Classify this Apollo mission. Return only JSON: {"complexity":"simple|standard|complex|critical","score":0.1,"confidence":0.8,"risk":"low|medium|high","intent":"short","reasoning":"one sentence"}',
          },
          { role: "user", content: goal },
        ],
        max_tokens: 180,
        temperature: 0.1,
        response_format: { type: "json_object" },
      }),
    });
    if (!response.ok) return { ...estimateMission(goal), via: "keywords" };
    const body = await response.json();
    const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? "{}");
    const complexity = ["simple", "standard", "complex", "critical"].includes(parsed.complexity)
      ? parsed.complexity
      : "standard";
    return {
      ...complexityToEstimate(complexity, clamp(Number(parsed.score ?? 0.5), 0.1, 0.95)),
      confidence: clamp(Number(parsed.confidence ?? 0.8), 0.5, 0.99),
      risk: ["low", "medium", "high"].includes(parsed.risk) ? parsed.risk : "medium",
      intent: String(parsed.intent ?? ""),
      reasoning: String(parsed.reasoning ?? ""),
      latency_ms: Date.now() - started,
      via: "semantic",
    };
  } catch {
    return { ...estimateMission(goal), via: "keywords" };
  }
}

export function estimateCost(goal, estimate, model) {
  const tokens = Math.max(800, Math.ceil(goal.length / 4) + estimate.agents.length * 1800);
  const multiplier =
    estimate.complexity === "critical"
      ? 0.000012
      : estimate.complexity === "complex"
        ? 0.000008
        : estimate.complexity === "standard"
          ? 0.000004
          : 0.000001;
  return {
    tokens,
    estimatedCost: Number((tokens * multiplier).toFixed(4)),
    model,
  };
}

function complexityToEstimate(complexity, score) {
  if (complexity === "simple") {
    return {
      complexity,
      score,
      route: "Free route",
      agents: ["Implementer"],
      budget: "near zero",
      confidence: 0.86,
      risk: "low",
      via: "keywords",
    };
  }
  if (complexity === "standard") {
    return {
      complexity,
      score,
      route: "Single premium",
      agents: ["Implementer"],
      budget: "low",
      confidence: 0.82,
      risk: "medium",
      via: "keywords",
    };
  }
  if (complexity === "critical") {
    return {
      complexity,
      score,
      route: "Consensus + mandatory review",
      agents: ["Planner", "Implementer", "Reviewer"],
      budget: "guarded",
      confidence: 0.74,
      risk: "high",
      via: "keywords",
    };
  }
  return {
    complexity,
    score,
    route: "Full orchestration",
    agents: ["Planner", "Implementer", "Reviewer"],
    budget: "controlled",
    confidence: 0.78,
    risk: "medium",
    via: "keywords",
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

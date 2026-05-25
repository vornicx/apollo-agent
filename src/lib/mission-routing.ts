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
};

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

export function estimateMission(goal: string): MissionEstimate {
  const normalized = goal.toLowerCase();
  const words = normalized.split(/\s+/).filter(Boolean).length;
  const complexHits = COMPLEX_KEYWORDS.filter((word) => normalized.includes(word)).length;
  const criticalHits = CRITICAL_KEYWORDS.filter((word) => normalized.includes(word)).length;
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

  if (complexity === "simple") {
    return {
      complexity,
      score,
      route: "Free route",
      agents: ["Qwen"],
      budget: "near zero",
      confidence: 0.86,
      risk: "low",
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
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

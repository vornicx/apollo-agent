import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APOLLO_DIR } from "./constants.mjs";

const SKILLS_DIR = "skills";
const REGISTRY_FILE = "skills-registry.json";

const skillsDir = (workspace) => join(workspace, APOLLO_DIR, SKILLS_DIR);
const registryPath = (workspace) => join(workspace, APOLLO_DIR, REGISTRY_FILE);

export function loadRegistry(workspace) {
  const p = registryPath(workspace);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function saveRegistry(workspace, registry) {
  mkdirSync(join(workspace, APOLLO_DIR), { recursive: true });
  writeFileSync(registryPath(workspace), JSON.stringify(registry, null, 2), "utf8");
}

export function listSkills(workspace) {
  return Object.values(loadRegistry(workspace));
}

export function getSkill(workspace, name) {
  return loadRegistry(workspace)[name] ?? null;
}

export async function installSkillCode(workspace, name, code, meta, source = "generated") {
  const dir = skillsDir(workspace);
  mkdirSync(dir, { recursive: true });
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const path = join(dir, `${slug}.mjs`);
  writeFileSync(path, code, "utf8");

  const registry = loadRegistry(workspace);
  registry[name] = { name, path, meta: meta ?? { name, description: "" }, source, installedAt: new Date().toISOString() };
  saveRegistry(workspace, registry);
  return path;
}

export async function runSkill(workspace, skillName, inputs = {}) {
  const skill = loadRegistry(workspace)[skillName];
  if (!skill) throw new Error(`Skill not found: ${skillName}`);
  if (!existsSync(skill.path)) throw new Error(`Skill file missing: ${skill.path}`);
  const mod = await import(`${skill.path}?bust=${Date.now()}`);
  if (typeof mod.run !== "function") throw new Error(`Skill "${skillName}" has no run() export`);
  return mod.run(inputs, { workspace });
}

export function formatSkillsContext(skills) {
  if (!skills.length) return "";
  const lines = ["## Available skills", ""];
  for (const s of skills) {
    lines.push(`### ${s.name}`);
    lines.push(s.meta?.description ?? "");
    if (s.meta?.inputs) lines.push(`Inputs: ${JSON.stringify(s.meta.inputs)}`);
    if (s.meta?.outputs) lines.push(`Outputs: ${JSON.stringify(s.meta.outputs)}`);
    lines.push("");
  }
  lines.push(
    'To invoke a skill, include it in your "skill_calls" array:',
    '  { "skill": "skill-name", "inputs": { ... }, "reason": "why" }',
  );
  return lines.join("\n");
}

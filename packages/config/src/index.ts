import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ModelRegistry, type ModelProfile, type RoutingPolicy } from "@archic/apollo-router";

/**
 * apollo.config.json — machine-local, gitignored. Secrets never live here:
 * providers reference environment variable NAMES, not key values.
 */
export interface ProviderCredentialConfig {
  /** Name of the environment variable holding the API key (preferred). */
  apiKeyEnv?: string;
  baseUrl?: string;
}

export interface MidasConfig {
  /** Command that starts the Midas MCP server (stdio). */
  command: string;
  args?: string[];
}

export interface ApolloConfig {
  providers?: Record<string, ProviderCredentialConfig>;
  models?: {
    register?: ModelProfile[];
    update?: Record<string, Partial<Omit<ModelProfile, "id">>>;
  };
  policy?: RoutingPolicy;
  midas?: MidasConfig;
}

export interface LoadedConfig {
  config: ApolloConfig;
  /** Absolute path of the file that was loaded; undefined when none exists. */
  path?: string;
}

export const CONFIG_FILENAME = "apollo.config.json";

/** The user-level fallback config, for running `apollo` outside any project. */
export function userConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "apollo", CONFIG_FILENAME);
}

/**
 * Walk upward from startDir looking for apollo.config.json; when no project
 * has one, fall back to ~/.config/apollo/apollo.config.json so a global
 * `apollo` keeps the user's models, keys, and Midas wiring from anywhere.
 */
export function findConfigPath(startDir: string = process.cwd()): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const fallback = userConfigPath();
  return existsSync(fallback) ? fallback : undefined;
}

export function loadConfig(startDir?: string): LoadedConfig {
  const path = findConfigPath(startDir);
  if (!path) return { config: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  const config = parsed as ApolloConfig;
  for (const model of config.models?.register ?? []) {
    if (!model.id || !model.provider || !model.cost || !model.latency) {
      throw new Error(
        `${path}: models.register entries need at least id, provider, cost, and latency (offending entry: ${JSON.stringify(model.id ?? model)})`,
      );
    }
  }
  return { config, path };
}

/** Seed defaults + config registrations/patches → the registry the router uses. */
export function buildRegistry(config: ApolloConfig): ModelRegistry {
  const registry = ModelRegistry.withDefaults();
  for (const model of config.models?.register ?? []) registry.register(model);
  for (const [id, patch] of Object.entries(config.models?.update ?? {})) {
    registry.update(id, patch); // throws on unknown ids — config errors should be loud
  }
  return registry;
}

export interface ResolvedCredentials {
  apiKey?: string;
  baseUrl?: string;
}

export function resolveCredentials(config: ApolloConfig, provider: string): ResolvedCredentials {
  const entry = config.providers?.[provider];
  const apiKey = entry?.apiKeyEnv ? process.env[entry.apiKeyEnv] : undefined;
  return { apiKey, baseUrl: entry?.baseUrl };
}

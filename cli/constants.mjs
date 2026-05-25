export const APOLLO_DIR = ".apollo";
export const APOLLO_DB = "apollo.db";
export const APOLLO_CONFIG = "config.json";
export const APOLLO_PROJECT_DOC = "APOLLO.md";
export const APOLLO_IGNORE = ".apolloignore";

export const VALID_MODES = new Set(["plan", "review", "auto", "full-auto"]);

export const DEFAULT_PROVIDER = "openrouter";
export const DEFAULT_MODEL = "auto";

export const DEFAULT_CONFIG = {
  version: 1,
  defaultMode: null,
  provider: DEFAULT_PROVIDER,
  model: DEFAULT_MODEL,
  maxEstimatedCost: 0.25,
  allowNetworkCommands: false,
  allowDestructiveCommands: false,
  allowAutoSkills: true,
};

export const DEFAULT_IGNORE = [
  ".apollo/",
  ".git/",
  "node_modules/",
  "dist/",
  ".next/",
  ".wrangler/",
  ".output/",
  ".vinxi/",
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*secret*",
  "*secrets*",
];

export const PROGRESS_WEIGHTS = {
  classify: 5,
  planning: 20,
  execution: 45,
  review: 20,
  reflection: 10,
};

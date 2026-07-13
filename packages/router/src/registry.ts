import { DEFAULT_MODELS } from "./defaults";
import type { ModelProfile } from "./types";

/**
 * The set of models Apollo may route to. Starts from seed defaults; user config
 * registers, patches, or disables entries. Registration order is preserved but
 * never load-bearing — routing sorts deterministically on its own.
 */
export class ModelRegistry {
  private readonly models = new Map<string, ModelProfile>();

  static withDefaults(): ModelRegistry {
    const registry = new ModelRegistry();
    for (const model of DEFAULT_MODELS) registry.register(model);
    return registry;
  }

  register(profile: ModelProfile): this {
    this.models.set(profile.id, profile);
    return this;
  }

  update(id: string, patch: Partial<Omit<ModelProfile, "id">>): this {
    const existing = this.models.get(id);
    if (!existing) throw new Error(`Unknown model: ${id}`);
    this.models.set(id, { ...existing, ...patch });
    return this;
  }

  get(id: string): ModelProfile | undefined {
    return this.models.get(id);
  }

  list(options: { enabledOnly?: boolean } = {}): ModelProfile[] {
    const all = [...this.models.values()];
    return options.enabledOnly === false ? all : all.filter((m) => m.enabled !== false);
  }
}

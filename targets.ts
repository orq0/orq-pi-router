import { readFileSync } from "node:fs";

export interface RoutingTarget {
  /** Stable, lowercase alias used in commands and persisted session state. */
  id: string;
  name: string;
  provider: string;
  model: string;
  /** Describe the tasks this model should handle, for Von classification. */
  description: string;
}

export interface RouterConfig {
  targets: RoutingTarget[];
}

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  targets: [
    {
      id: "local",
      name: "LOCAL",
      provider: "local",
      model: "model",
      description:
        "Routine, well-defined implementation, simple edits, and ordinary tool use.",
    },
    {
      id: "astra",
      name: "ASTRA",
      provider: "openai",
      model: "gpt-6-astra",
      description:
        "Difficult architecture, deep reasoning, security analysis, and persistent failures.",
    },
  ],
};

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a nonempty string`);
  }
  return value.trim();
}

export function validateRouterConfig(raw: unknown): RouterConfig {
  if (!raw || typeof raw !== "object")
    throw new Error("Router config must be an object");
  const config = raw as Record<string, unknown>;
  if (!Array.isArray(config.targets) || config.targets.length === 0) {
    throw new Error("targets must contain at least one model");
  }
  const ids = new Set<string>();
  const models = new Set<string>();
  const targets = config.targets.map(
    (value: unknown, i: number): RoutingTarget => {
      if (!value || typeof value !== "object")
        throw new Error(`targets[${i}] must be an object`);
      const t = value as Record<string, unknown>;
      const id = requiredString(t.id, `targets[${i}].id`);
      if (
        !/^[a-z][a-z0-9_-]*$/.test(id) ||
        ["auto", "router", "manual", "models", "uncertain"].includes(id)
      ) {
        throw new Error(`Invalid or reserved target id: ${id}`);
      }
      if (ids.has(id)) throw new Error(`Duplicate target id: ${id}`);
      ids.add(id);
      const provider = requiredString(t.provider, `${id}.provider`);
      const model = requiredString(t.model, `${id}.model`);
      if (provider === "auto-router")
        throw new Error("auto-router cannot be a routing target");
      const identity = JSON.stringify([provider, model]);
      if (models.has(identity))
        throw new Error(`Duplicate provider/model: ${provider}/${model}`);
      models.add(identity);
      return {
        id,
        name:
          t.name === undefined
            ? id.toUpperCase()
            : requiredString(t.name, `${id}.name`),
        provider,
        model,
        description: requiredString(t.description, `${id}.description`),
      };
    },
  );
  return { targets };
}

/** Missing default file keeps legacy targets; explicit or invalid files fail visibly. */
export function loadRouterConfig(
  path = process.env.PI_ROUTER_CONFIG,
): RouterConfig {
  const source = path || new URL("./router.config.json", import.meta.url);
  let text: string;
  try {
    text = readFileSync(source, "utf8");
  } catch (error) {
    if (!path && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return validateRouterConfig(DEFAULT_ROUTER_CONFIG);
    }
    throw new Error(`Cannot read router config: ${(error as Error).message}`);
  }
  try {
    return validateRouterConfig(JSON.parse(text));
  } catch (error) {
    throw new Error(`Invalid router config: ${(error as Error).message}`);
  }
}

/**
 * Von classification adapter for AUTO routing among configured models.
 * Von is the semantic classifier; network/protocol failures return null so the
 * router can block AUTO execution. Manual selection bypasses it.
 */

import { readFileSync } from "node:fs";

/* =========================================================
   TYPES
========================================================= */

export type VonChoice = string;

/** Normalized routing data returned by the Von adapter. */
export interface VonDecision {
  choice: VonChoice;
  probabilities: Record<VonChoice, number>;
  confidence: number;
}

/** Result of applying the policy engine to Von's decision. */
export type PolicyOutcome = {
  /** Von's selected alias, or null when no usable decision exists. */
  decision: VonChoice | null;
  /** Human-readable rationale (surfaced in the status line for transparency). */
  reason: string;
  /** The raw Von decision, preserved for the status line / diagnostics. */
  von: VonDecision | null;
};

/**
 * Compact, routing-relevant snapshot of the current router state. This is the
 * ONLY thing sent to Von — never the full conversation/history.
 */
export interface RoutingSnapshot {
  task: string;
  phase: "normal" | "debugging";
  attempts: number;
  toolErrors: number;
  testFailures: number;
  filesChanged: number;
  securitySensitive: boolean;
  currentModel: VonChoice | null;
}

/* =========================================================
   CONFIG (router's normal config mechanism)
========================================================= */

/**
 * Centralized Von configuration. The Von server URL defaults to the standard
 * local endpoint so the normal local setup requires NO manual configuration.
 * Values can be overridden by `von.config.json` (see README / VON_INTEGRATION).
 */
export interface VonConfig {
  /** Von server base URL (e.g. http://127.0.0.1:8100). */
  url: string;
  /** AUTO requires Von; disabling it leaves manual modes available. */
  enabled: boolean;
  /** Short localhost timeout so a dead Von server cannot stall the agent. */
  timeoutMs: number;
  /**
   * Von System One decision model id (e.g. `von-latest`). The local Von server
   * resolves model names to a concrete engine; this is only the request hint.
   */
  model: string;
  /**
   * Evaluation criteria keyed by option name, sent as the System One question's
   * `criteria`. Per-alias entries override configured target descriptions.
   * The binary defaults remain available for direct VonClient callers.
   */
  criteria: Record<VonChoice, string>;
}

export const DEFAULT_VON_CONFIG: VonConfig = {
  url: "http://127.0.0.1:8100",
  enabled: true,
  timeoutMs: 5000,
  model: "von-latest",
  criteria: { LOCAL: "LOCAL", ASTRA: "ASTRA" },
};

/* =========================================================
   ROUTING INSTRUCTION (centralized, configurable)
========================================================= */

/**
 * The routing instruction sent to Von. Centralized here so it lives in exactly
 * one place (not scattered across the codebase) and is easy to retune.
 */
export const ROUTING_INSTRUCTION =
  "Choose which model should undertake the task, using the task, failure signals, and each candidate's description. Select among the offered options only. Prefer an efficient model sufficient for routine work; choose a stronger reasoning model for difficult architecture, security-sensitive analysis, or repeated failures. Return calibrated probabilities for all offered models.";

/**
 * The question key inside the System One `questions` envelope. Fixed value so the
 * request builder and the response extractor agree on which answer to read.
 */
export const ROUTING_QUESTION_KEY = "routing";

/** Legacy criteria for callers using VonClient directly without custom targets. */
export const ROUTING_CRITERIA: Record<VonChoice, string> = {
  LOCAL: "LOCAL",
  ASTRA: "ASTRA",
};

/* =========================================================
   SNAPSHOT BUILDER
========================================================= */

/**
 * Derive the compact routing snapshot from the existing router state. The fields
 * are read from pi-router's own state — no second independent state system.
 */
export function buildRoutingSnapshot(
  s: {
    task?: string;
    attempts?: number;
    toolErrors?: number;
    testFailures?: number;
    filesChanged?: number;
    securitySensitive?: boolean;
    consecutiveFailures?: number;
    currentTarget: string | null;
  },
  taskText: string,
): RoutingSnapshot {
  // `phase` is DERIVED from the existing deterministic failure state, so we never
  // maintain a second independent notion of "what phase we are in".
  const phase: "normal" | "debugging" =
    (s.consecutiveFailures ?? 0) > 0 ? "debugging" : "normal";
  return {
    task: (taskText || s.task || "").trim().slice(0, 2000),
    phase,
    attempts: clampInt(s.attempts, 0),
    toolErrors: clampInt(s.toolErrors, 0),
    testFailures: clampInt(s.testFailures, 0),
    filesChanged: clampInt(s.filesChanged, 0),
    securitySensitive: Boolean(s.securitySensitive),
    currentModel: s.currentTarget?.toUpperCase() ?? null,
  };
}

function clampInt(n: number | undefined, def: number): number {
  return Number.isFinite(n as number) && (n as number) > 0
    ? (n as number)
    : def;
}

/* =========================================================
   DECISION VALIDATION (Von owns model selection)
========================================================= */

/** Validate and pass through Von's choice. Probabilities never override it. */
export function policyEngine(
  von: VonDecision | null,
  config: { choices?: string[] } = {},
): PolicyOutcome {
  const decision =
    von &&
    normalizeVonDecision(
      von,
      config.choices ?? Object.keys(von.probabilities ?? {}),
    );
  if (!decision) {
    return {
      decision: null,
      reason: von
        ? "von: invalid decision; no model selected"
        : "von unavailable; no model selected",
      von: null,
    };
  }
  return {
    decision: decision.choice,
    reason: `von: selected ${decision.choice} (probability ${round2(decision.probabilities[decision.choice])}, confidence ${round2(decision.confidence)})`,
    von: decision,
  };
}

function round2(n: number): string {
  return (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2);
}

/* =========================================================
   VON HTTP ADAPTER
========================================================= */

/**
 * Isolated Von HTTP client. Responsibilities:
 *   - build the Von request
 *   - send the localhost HTTP request (with a short timeout)
 *   - parse + normalize the response
 *   - return null on ANY failure (offline, timeout, malformed, bad choice)
 *
 * It knows nothing about routing policy. Policy lives in `policyEngine()`.
 */
export class VonClient {
  constructor(
    private readonly config: Pick<
      VonConfig,
      "url" | "timeoutMs" | "model" | "criteria"
    >,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async decide(snapshot: RoutingSnapshot): Promise<VonDecision | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      // System One request shape:
      //   { model, state, questions: { <key>: { instructions, criteria, options } } }
      const body = {
        model: this.config.model,
        state: snapshot,
        questions: {
          [ROUTING_QUESTION_KEY]: {
            type: "choice",
            instructions: ROUTING_INSTRUCTION,
            criteria: this.config.criteria,
            options: Object.keys(this.config.criteria),
          },
        },
      };

      const res = await this.fetchImpl(`${this.config.url}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) return null;

      const json = await res.json().catch(() => null);
      // The answer lives under `answers[<questionKey>]`; pull it out of the
      // envelope so normalizeVonDecision sees the inner ChoiceAnswer shape
      // ({ choice, probabilities, confidence }).
      return normalizeVonDecision(
        extractChoiceAnswer(json),
        Object.keys(this.config.criteria),
      );
    } catch {
      // AbortError (timeout), network error, DNS failure, etc.
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Pull the per-question ChoiceAnswer out of the System One response envelope
 * `{ model, answers: { <key>: ChoiceAnswer }, usage }`.
 *
 * Returns the raw inner answer for `ROUTING_QUESTION_KEY`, or the input itself
 * if the envelope is absent (defensive: a flat `{ choice, ... }` object passes
 * straight through to normalizeVonDecision). Returns null when the routing
 * question's answer is missing so normalizeVonDecision rejects it.
 */
export function extractChoiceAnswer(envelope: unknown): unknown {
  if (!envelope || typeof envelope !== "object") return envelope;
  const r = envelope as Record<string, unknown>;
  const answers = r.answers;
  if (!answers || typeof answers !== "object") return r; // flat shape
  const q = (answers as Record<string, unknown>)[ROUTING_QUESTION_KEY];
  return q ?? null;
}

/**
 * Validate + normalize a raw Von response into a VonDecision, or return null if
 * the shape is wrong. Defensive on every field so malformed data can never crash
 * the router.
 */
export function normalizeVonDecision(
  raw: unknown,
  choices: string[] = ["LOCAL", "ASTRA"],
): VonDecision | null {
  if (!raw || typeof raw !== "object" || !choices.length) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.choice !== "string" || !choices.includes(r.choice)) return null;
  if (!r.probabilities || typeof r.probabilities !== "object") return null;
  const rawProbabilities = r.probabilities as Record<string, unknown>;
  if (Object.keys(rawProbabilities).length !== choices.length) return null;
  const probabilities: Record<string, number> = {};
  for (const choice of choices) {
    const value = rawProbabilities[choice];
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1
    )
      return null;
    probabilities[choice] = value;
  }
  return {
    choice: r.choice,
    probabilities,
    confidence: toConfidence(r.confidence),
  };
}

function toConfidence(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/* =========================================================
   CONFIG LOADER (router's normal config mechanism)
========================================================= */

/**
 * Merge the compiled-in defaults with an optional `von.config.json` living next
 * to this module. Never throws: a missing or unreadable config file simply yields
 * the defaults. Personal/system-specific values must never be committed here.
 *
 * `overrides` lets callers (and tests) pin specific values without a config file.
 */
export function loadVonConfig(overrides: Partial<VonConfig> = {}): VonConfig {
  const merged: VonConfig = { ...DEFAULT_VON_CONFIG, ...overrides };
  try {
    const file =
      process.env.PI_ROUTER_VON_CONFIG ||
      new URL("./von.config.json", import.meta.url);
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    if (parsed && typeof parsed === "object") {
      const c = parsed as Record<string, unknown>;
      if (typeof c.url === "string" && c.url.trim()) merged.url = c.url.trim();
      if (typeof c.enabled === "boolean") merged.enabled = c.enabled;
      if (
        typeof c.timeoutMs === "number" &&
        Number.isFinite(c.timeoutMs) &&
        c.timeoutMs > 0
      )
        merged.timeoutMs = c.timeoutMs;
      if (typeof c.model === "string" && c.model.trim())
        merged.model = c.model.trim();
      const crit = c.criteria as Record<string, unknown> | undefined;
      if (crit && typeof crit === "object") {
        const mergedCrit: Record<VonChoice, string> = {};
        for (const key of Object.keys(crit)) {
          if (typeof crit[key] === "string" && crit[key].trim())
            mergedCrit[key] = crit[key];
        }
        if (Object.keys(mergedCrit).length > 0) merged.criteria = mergedCrit;
      }
    }
  } catch {
    /* config file missing/unreadable -> keep defaults */
  }
  return merged;
}

/* =========================================================
   MODULE-LEVEL SEAM (config + client, injectable for tests)
========================================================= */

// The live, merged config. Initialized once at import from the router's config
// file; overridable in tests via setVonConfigForTests().
let currentConfig: VonConfig = loadVonConfig();

// Factory that produces a VonClient. The default uses the real global fetch and
// the live config; tests inject a factory that returns a fake client (so no real
// HTTP server is ever required).
type VonClientFactory = (config: VonConfig) => VonClient;
let vonClientFactory: VonClientFactory = (cfg) => new VonClient(cfg);

/** Pin a specific VonConfig (used by tests). */
export function setVonConfigForTests(cfg: VonConfig): void {
  currentConfig = cfg;
}

/** The live, merged config. The router reads the *enabled* flag from here so
 * there is a single source of truth (tests can flip it on). */
export function getVonConfig(): VonConfig {
  return currentConfig;
}

/** Restore the production config loader (used by tests). */
export function resetVonConfigForTests(): void {
  currentConfig = loadVonConfig();
}

/** Inject a custom VonClient factory (used by tests). */
export function setVonClientFactoryForTests(fn: VonClientFactory | null): void {
  vonClientFactory = fn ?? ((cfg) => new VonClient(cfg));
}

/**
 * The single entry point the router calls. Honors the `enabled` flag: when Von
 * integration is disabled this returns null (AUTO must block). When enabled it
 * builds the snapshot, calls the (possibly injected) client, and normalizes.
 * Returns null on ANY failure so the router can fall back safely.
 */
export async function getVonDecision(
  snapshot: RoutingSnapshot,
  criteria?: Record<string, string>,
): Promise<VonDecision | null> {
  if (!currentConfig.enabled) return null;
  try {
    return await vonClientFactory({
      ...currentConfig,
      criteria: criteria ?? currentConfig.criteria,
    }).decide(snapshot);
  } catch {
    return null;
  }
}

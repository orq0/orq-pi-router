/**
 * Automatic routing among user-configured Pi provider/model targets.
 * AUTO uses Von classification; manual selections and commands pin a model.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
  ModelSelectEvent,
  TurnEndEvent,
  TurnStartEvent,
  InputEvent,
  InputEventResult,
  BeforeAgentStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
  loadRouterConfig,
  type RouterConfig,
  type RoutingTarget,
} from "./targets.ts";
import {
  buildRoutingSnapshot,
  policyEngine,
  getVonDecision,
  getVonConfig,
} from "./von.ts";

/* =========================================================
   CONSTANTS
========================================================= */

// Virtual provider/model that stands in for the AUTO option inside the selector.
const PROVIDER_AUTO = "auto-router";
const MODEL_AUTO = "auto-router";

// Custom-entry types persisted into the session file (not sent to the LLM).
const STATE_CUSTOM_TYPE = "router-state";
const DISPLAY_CUSTOM_TYPE = "router-status";

type Mode = string; // "auto", "manual", or a configured target ID
type Target = string | null;
let routerConfig: RouterConfig;

interface RouterState {
  mode: Mode;
  currentTarget: Target;
  consecutiveFailures: number;
  totalDecisions: number;
  totalSwitches: number;
  totalFailures: number;
  lastFailure: string;
  lastDecision: string;
  lastDecisionReason: string;
  history: Array<{ ts: string; from: Target; to: Target; reason: string }>;
  // ---- Routing-snapshot fields (used to build the compact Von request) ----
  // These are derived from, and augment, the deterministic state above; they do
  // NOT replace it. Every field has a safe default so an absent value never
  // breaks routing.
  attempts: number; // model-generation attempts in the current phase
  toolErrors: number; // repeated tool errors so far
  testFailures: number; // persistent test failures so far
  filesChanged: number; // files written in the current phase
  securitySensitive: boolean; // security-sensitive work detected
  lastDecisionReasonVon: string; // last Von/policy rationale (status line)
}

const DEFAULT_STATE: RouterState = {
  mode: "auto",
  currentTarget: null,
  consecutiveFailures: 0,
  totalDecisions: 0,
  totalSwitches: 0,
  totalFailures: 0,
  lastFailure: "",
  lastDecision: "",
  lastDecisionReason: "",
  history: [],
  attempts: 0,
  toolErrors: 0,
  testFailures: 0,
  filesChanged: 0,
  securitySensitive: false,
  lastDecisionReasonVon: "",
};

/* =========================================================
   STATE
========================================================= */

// In-memory state is the source of truth for the live session.
let state: RouterState = { ...DEFAULT_STATE };
// Guards against re-entrancy: when we programmatically switch the model via
// setModel(), Pi emits a "set" model_select that we must not treat as a manual
// user selection.
let applyingRouterModel = false;
// Authorization is scoped to an active task, not a cached choice from an older task.
let authorizedTask = false;
let modeRevision = 0;
let pendingDecision: { target: Target; reason: string } | null = null;

function cloneState(): RouterState {
  return {
    ...state,
    history: state.history.map((h) => ({ ...h })),
  };
}

function persistState(): void {
  try {
    // appendEntry writes a custom entry into the session file so routing state
    // survives compaction/rollback. It is never sent to the LLM.
    (
      pi as unknown as {
        appendEntry: (customType: string, data?: unknown) => void;
      }
    ).appendEntry(STATE_CUSTOM_TYPE, cloneState());
  } catch {
    /* non-critical */
  }
}

function recordSwitch(from: Target, to: Target, reason: string): void {
  const ts = new Date().toISOString();
  state.totalSwitches += 1;
  state.history.push({ ts, from, to, reason });
  if (state.history.length > 50) state.history.shift();
  persistState();
}

/* =========================================================
   PROVIDER / MODEL LOOKUPS
========================================================= */

// Resolve the FULLY-CONFIGURED model from Pi's registry so that `api`,
// `baseUrl`, headers, and every other piece of provider configuration are
// preserved when passed to `pi.setModel()`.
//
// WHY THIS MATTERS: `pi.setModel(model)` stores the passed object *verbatim*
// as `agent.state.model`. If we pass a bare `{ provider, id }` reference, its
// `api` field is `undefined`, so the subsequent provider request resolves with
// `api: undefined` -> "No API provider registered for api: undefined".
//
// The normal Pi `/model` selector works with `local/model` precisely because it
// passes the *fully-resolved* registry model (which always carries an `api`).
// `ctx.modelRegistry.find(provider, id)` is the supported lookup that returns a
// complete `Model`, so we use it instead of constructing a minimal reference.
function targetModel(
  ctx: ExtensionContext,
  target: Target,
): ReturnType<typeof ctx.modelRegistry.find> {
  const configured = routerConfig.targets.find((t) => t.id === target);
  return configured
    ? ctx.modelRegistry.find(configured.provider, configured.model)
    : undefined;
}

function isTargetAvailable(ctx: ExtensionContext, target: Target): boolean {
  try {
    const model = targetModel(ctx, target);
    return Boolean(
      model && (ctx.modelRegistry.hasConfiguredAuth?.(model) ?? true),
    );
  } catch {
    return false;
  }
}

function availableTargets(ctx: ExtensionContext): RoutingTarget[] {
  return routerConfig.targets.filter((t) => isTargetAvailable(ctx, t.id));
}

// Failure-classification hints for the routing snapshot. Used only to populate
// the diagnostic counters (testFailures / toolErrors) sent to Von.
const TEST_FAILURE_HINTS = [
  "test",
  "tests",
  "failing",
  "assertion",
  "assert failed",
  "expected",
  "snapshot mismatch",
  "jest",
  "vitest",
  "pytest",
];
const TOOL_ERROR_HINTS = [
  "tool",
  "tool_error",
  "tool call",
  "tool call failed",
  "function call",
  "tool execution",
];

/** AUTO requires an available candidate and a valid decision from Von. */
async function decideTarget(
  text: string,
  ctx: ExtensionContext,
): Promise<{ target: Target; reason: string }> {
  if (!getVonConfig().enabled)
    return {
      target: null,
      reason: "Von is disabled. Enable Von or select a manual model.",
    };
  const candidates = availableTargets(ctx);
  if (!candidates.length)
    return {
      target: null,
      reason:
        "No configured routing targets are available. Configure a model in Pi.",
    };
  return (
    (await evaluateVon(text, candidates)) ?? {
      target: null,
      reason:
        "Von is unavailable or returned an invalid decision. Restore Von or select a manual model.",
    }
  );
}

/* =========================================================
   VON (AUTO only) — evaluation-point gating + policy
========================================================= */

// Security-sensitive keywords. When present in the task we flag it so Von sees a
// strong escalation signal. Derived from the task text (no second state system).
const SECURITY_HINTS = [
  "security",
  "vuln",
  "vulnerability",
  "auth",
  "authorization",
  "permission",
  "privilege",
  "crypto",
  "cryptography",
  "cve",
  "exploit",
  "injection",
  "sandbox",
  "isolation",
];

function isSecuritySensitive(text: string): boolean {
  const lower = ` ${text.toLowerCase()} `;
  return SECURITY_HINTS.some((h) => lower.includes(` ${h} `));
}

/**
 * Build the compact snapshot and validate Von's choice. Failure selects no model.
 */
async function evaluateVon(
  text: string,
  candidates: RoutingTarget[],
): Promise<{ target: Target; reason: string } | null> {
  try {
    // Flag security-sensitive work so Von sees it as a strong escalation signal.
    if (isSecuritySensitive(text)) state.securitySensitive = true;

    const snapshot = buildRoutingSnapshot(
      {
        consecutiveFailures: state.consecutiveFailures,
        attempts: state.attempts,
        toolErrors: state.toolErrors,
        testFailures: state.testFailures,
        filesChanged: state.filesChanged,
        securitySensitive: state.securitySensitive,
        currentTarget: state.currentTarget,
      },
      text,
    );

    const config = getVonConfig();
    const criteria = Object.fromEntries(
      candidates.map((t) => {
        const choice = t.id.toUpperCase();
        const override = config.criteria[choice];
        return [
          choice,
          override && override !== choice ? override : t.description,
        ];
      }),
    );
    const von = await getVonDecision(snapshot, criteria);
    if (von === null) return null;

    const outcome = policyEngine(von, {
      choices: candidates.map((t) => t.id.toUpperCase()),
    });
    if (outcome.decision === null) return null;
    state.lastDecisionReasonVon = outcome.reason;
    return { target: outcome.decision.toLowerCase(), reason: outcome.reason };
  } catch {
    // Von must never crash Pi.
    return null;
  }
}

/* =========================================================
   ROUTING ACTIONS
========================================================= */

function setMode(mode: Mode): void {
  const was = state.mode;
  state.mode = mode;
  modeRevision += 1;
  authorizedTask = false;
  pendingDecision = null;
  state.lastDecisionReason = `mode set to ${mode}`;
  if (was !== mode) persistState();
}

function blockAuto(reason: string): void {
  state.lastDecisionReason = `AUTO blocked: ${reason}`;
  persistState();
  sendStatus(state.lastDecisionReason);
}

/**
 * Apply a routing decision by switching the active model through Pi's own
 * setModel(). We await the switch and only commit the routing state after it
 * completes successfully, so a failed switch is never reported as a success.
 * The resulting "set" model_select event is ignored via the applyingRouterModel
 * guard.
 */
async function applyTarget(
  ctx: ExtensionContext,
  target: Target,
  reason: string,
): Promise<boolean> {
  if (!target) {
    state.lastDecisionReason = reason;
    persistState();
    showStatus(ctx);
    return false;
  }

  applyingRouterModel = true;
  const prev = state.currentTarget;
  try {
    const model = targetModel(ctx, target);
    if (!model) throw new Error("provider/model not found in Pi's registry");
    const switched = await pi.setModel(model);
    if (!switched)
      throw new Error(
        "Pi rejected the model switch (check provider authentication)",
      );
  } catch (err) {
    // On failure, do not pretend the switch succeeded: record the failure
    // reason and leave state.currentTarget pointing at the still-active model.
    state.lastDecisionReason = `cannot switch to ${describeTarget(target)}: provider not configured`;
    state.lastFailure = (err as Error)?.message || "setModel failed";
    persistState();
    return false;
  } finally {
    // Always release the guard once setModel() has settled.
    applyingRouterModel = false;
  }

  // Only reached on successful completion.
  state.currentTarget = target;
  state.lastDecision = target;
  state.lastDecisionReason = reason;
  state.totalDecisions += 1;
  if (prev !== target) recordSwitch(prev, target, reason);
  persistState();
  return true;
}

/* =========================================================
   SESSION-FILE STATE RESTORE
========================================================= */

function restoreStateFromSession(ctx: ExtensionContext): void {
  state = { ...DEFAULT_STATE, history: [] };
  try {
    // Use the active branch only, never other sessions in the same directory.
    let restored: Partial<RouterState> | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type === "custom" &&
        entry.customType === STATE_CUSTOM_TYPE &&
        entry.data &&
        typeof entry.data === "object"
      ) {
        restored = entry.data as Partial<RouterState>;
      }
    }
    if (restored && typeof restored.mode === "string") {
      state = {
        ...DEFAULT_STATE,
        ...restored,
        history: Array.isArray(restored.history) ? restored.history : [],
      };
      if (
        state.currentTarget &&
        !routerConfig.targets.some((t) => t.id === state.currentTarget)
      ) {
        state.currentTarget = null;
      }
      if (
        !["auto", "manual", ...routerConfig.targets.map((t) => t.id)].includes(
          state.mode,
        )
      ) {
        state.mode = "auto";
      }
    }
  } catch {
    // A missing or invalid session entry leaves the default routing state.
  }
}

/* =========================================================
   STATUS DISPLAY
========================================================= */

function describeTarget(t: Target): string {
  return routerConfig.targets.find((target) => target.id === t)?.name ?? "—";
}

function buildStatusLine(): string {
  const mode = state.mode.toUpperCase();
  const target = describeTarget(state.currentTarget);
  return (
    `Router: **${mode}** → ${target}  ` +
    `(decisions ${state.totalDecisions}, switches ${state.totalSwitches}, ` +
    `failures ${state.totalFailures}, last: ${state.lastDecision || "none"} ` +
    `${state.lastDecisionReason || ""}` +
    (state.lastFailure ? ` | last-failure: ${state.lastFailure}` : "") +
    `)`
  );
}

function showStatus(ctx: ExtensionContext): void {
  try {
    (
      pi as unknown as {
        sendMessage: (msg: unknown) => void;
      }
    ).sendMessage({
      customType: DISPLAY_CUSTOM_TYPE,
      content: buildStatusLine(),
      display: true,
      details: cloneState(),
    });
  } catch {
    /* non-critical */
  }
}

/* =========================================================
   EVENT HANDLERS
========================================================= */

// User (or command) selected a model from the selector.
function handleModelSelect(
  event: ModelSelectEvent,
  ctx: ExtensionContext,
): void {
  const { model } = event;

  // Ignore switches we initiated ourselves.
  if (applyingRouterModel || event.source === "restore") return;

  // AUTO chosen in the selector.
  if (model.provider === PROVIDER_AUTO && model.id === MODEL_AUTO) {
    setMode("auto");
    state.lastDecisionReason = "user selected AUTO";
    persistState();
    // Decide + switch on the next turn boundary instead of interrupting the
    // selector flow.
    return;
  }

  const selected = routerConfig.targets.find(
    (t) => t.provider === model.provider && t.model === model.id,
  );
  setMode(selected?.id ?? "manual");
  state.currentTarget = selected?.id ?? null;
  state.lastDecision = selected?.id ?? `${model.provider}/${model.id}`;
  state.lastDecisionReason = `user selected ${selected?.name ?? state.lastDecision}`;
  persistState();
}

// A deferred input was classified before queueing; apply it only at a safe boundary.
async function handleTurnStart(
  _event: TurnStartEvent,
  ctx: ExtensionContext,
): Promise<void> {
  state.attempts += 1;
  if (state.mode !== "auto") return;
  if (pendingDecision) {
    const decision = pendingDecision;
    pendingDecision = null;
    authorizedTask = await applyTarget(ctx, decision.target, decision.reason);
  }
  if (!authorizedTask) {
    blockAuto(
      "No valid Von selection is available for this task. Resubmit the task or choose a manual model.",
    );
    ctx.abort();
  }
}

// Consume failed AUTO inputs so Pi never starts a task on a previous/default model.
async function handleInput(
  event: InputEvent,
  ctx: ExtensionContext,
): Promise<InputEventResult | void> {
  if (state.mode !== "auto") return;
  if (pendingDecision) {
    blockAuto(
      "An AUTO task is already queued. Wait until it starts before submitting another task.",
    );
    return { action: "handled" };
  }
  const revision = modeRevision;
  if (ctx.isIdle()) authorizedTask = false;
  const decision = await decideTarget(event.text || "", ctx);
  if (state.mode !== "auto") return; // A manual selection made while Von was running wins.
  if (revision !== modeRevision) {
    blockAuto("Routing mode changed during classification. Resubmit the task.");
    return { action: "handled" };
  }
  if (!decision.target) {
    blockAuto(decision.reason);
    return { action: "handled" };
  }
  if (pendingDecision) {
    blockAuto(
      "An AUTO task is already queued. Wait until it starts before submitting another task.",
    );
    return { action: "handled" };
  }
  if (!ctx.isIdle()) {
    pendingDecision = decision;
    return;
  }
  authorizedTask = await applyTarget(ctx, decision.target, decision.reason);
  if (!authorizedTask) {
    blockAuto(
      "Pi could not select Von's chosen model. Configure it or choose a manual model.",
    );
    return { action: "handled" };
  }
}

// Covers run triggers that do not emit an input event, such as custom extension messages.
async function handleBeforeAgentStart(
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
): Promise<void> {
  if (state.mode !== "auto" || authorizedTask) return;
  const revision = modeRevision;
  const text =
    event.messageType === "user"
      ? event.prompt
      : typeof event.message.content === "string"
        ? event.message.content
        : JSON.stringify(event.message.content);
  const decision = pendingDecision ?? (await decideTarget(text, ctx));
  pendingDecision = null;
  if (state.mode !== "auto") return;
  if (revision === modeRevision && decision.target) {
    authorizedTask = await applyTarget(ctx, decision.target, decision.reason);
  }
  if (!authorizedTask) {
    blockAuto(
      decision.target
        ? "Pi could not apply Von's selection. Resubmit the task or choose a manual model."
        : decision.reason,
    );
    ctx.abort();
  }
}

// Per-turn outcome tracking for Von's routing context.
//
// `turn_end` fires on EVERY turn — success and failure alike — carrying the
// final assistant message. On a provider/request failure (e.g. "no credits
// remaining" -> HTTP 402) the OpenAI SDK throws before any tool runs, so the
// tool_execution_end event never fires and the failure would otherwise go
// completely undetected. Inspecting `message.stopReason` here catches both
// provider failures AND tool errors from a single, reliable event.
function handleTurnEnd(event: TurnEndEvent): void {
  const msg = event?.message;
  if (!msg || msg.role !== "assistant") return;
  // Only a real error advances the failure counters sent to Von; user cancellation does not.
  if (msg && msg.stopReason === "error") {
    // A context-window overflow (e.g. local llama.cpp: "68820 tokens exceeds
    // the available context size 65536") is NOT a routing failure — it is a
    // property of the current conversation, not the provider. It is therefore
    // neutral for failure tracking: it neither advances the failure streak nor resets it.
    if (isContextWindowError(msg)) return;

    state.totalFailures += 1;
    state.consecutiveFailures += 1;
    state.lastFailure = msg.errorMessage || `${msg.stopReason} during turn`;
    // Classify the failure into the routing-snapshot counters. These are
    // diagnostic signals for Von. A persistent test failure and a repeated tool error are both
    // "the model is misbehaving" signals, but they are tracked separately so Von
    // can react to them distinctly.
    const why = (msg.errorMessage || msg.stopReason || "").toLowerCase();
    if (TEST_FAILURE_HINTS.some((h) => why.includes(h))) {
      state.testFailures += 1;
    }
    if (TOOL_ERROR_HINTS.some((h) => why.includes(h))) {
      state.toolErrors += 1;
    }
    persistState();
  } else if (state.consecutiveFailures > 0) {
    // A successful turn resets the failure streak regardless of mode.
    state.consecutiveFailures = 0;
    persistState();
  }
}

// Context-window overflow detection.
//
// Local llama.cpp reports an oversized conversation as an "error" stopReason
// with a message like:
//   "400 request (68820 tokens) exceeds the available context size (65536 tokens)"
// We match a small set of case-insensitive substrings so such an error is not
// mistaken for a provider/credit failure.
function isContextWindowError(
  msg: Extract<TurnEndEvent["message"], { role: "assistant" }>,
): boolean {
  const text = (msg.errorMessage || msg.stopReason || "").toLowerCase();
  return (
    text.includes("context size") ||
    text.includes("context window") ||
    text.includes("context length") ||
    text.includes("exceeds the available context") ||
    text.includes("maximum context") ||
    text.includes("too many tokens") ||
    text.includes("token limit")
  );
}

// Session start: restore persisted routing state.
function handleSessionStart(
  event: { reason: string },
  ctx: ExtensionContext,
): void {
  authorizedTask = false;
  pendingDecision = null;
  modeRevision += 1;
  restoreStateFromSession(ctx);
  showStatus(ctx);
}

/* =========================================================
   SLASH COMMANDS
========================================================= */

function sendStatus(content: string): void {
  pi.sendMessage({ customType: DISPLAY_CUSTOM_TYPE, content, display: true });
}

async function forceTarget(
  id: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  await ctx.waitForIdle();
  const target = routerConfig.targets.find((t) => t.id === id);
  if (!target) {
    sendStatus(
      `Unknown routing target "${id}". Use /router models to list configured targets.`,
    );
    return;
  }
  if (!isTargetAvailable(ctx, id)) {
    sendStatus(
      `${target.name} (${target.provider}/${target.model}) is not available. Configure the model and authentication in Pi.`,
    );
    return;
  }
  if (await applyTarget(ctx, id, `command /router ${id}`)) {
    setMode(id);
    persistState();
  }
  showStatus(ctx);
}

function registerCommands(): void {
  pi.registerCommand("auto", {
    description: "Enable automatic routing among configured models using Von",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      setMode("auto");
      state.lastDecisionReason = "command /auto";
      persistState();
      showStatus(ctx);
    },
  });
  // Preserve Pi's own command names; these aliases remain usable through /router <id>.
  const builtinCommands = new Set([
    "settings",
    "model",
    "tree",
    "thinking",
    "scoped-models",
    "export",
    "import",
    "share",
    "bug",
    "copy",
    "name",
    "session",
    "changelog",
    "hotkeys",
    "fork",
    "clone",
    "trust",
    "login",
    "logout",
    "new",
    "compact",
    "resume",
    "reload",
    "quit",
  ]);
  for (const id of new Set([
    "local",
    "astra",
    ...routerConfig.targets.map((t) => t.id),
  ])) {
    if (builtinCommands.has(id)) continue;
    pi.registerCommand(id, {
      description: `Force the configured ${id.toUpperCase()} target (alias for /router ${id})`,
      handler: async (_args, ctx) => forceTarget(id, ctx),
    });
  }
  pi.registerCommand("router", {
    description:
      "Show status, list targets (/router models), or select one (/router <id>)",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id) {
        await ctx.waitForIdle();
        showStatus(ctx);
        return;
      }
      if (id === "models") {
        sendStatus(
          routerConfig.targets
            .map(
              (t) =>
                `${t.id}: ${t.name} — ${t.provider}/${t.model} (${isTargetAvailable(ctx, t.id) ? "available" : "unavailable"})`,
            )
            .join("\n"),
        );
        return;
      }
      await forceTarget(id, ctx);
    },
  });
}

/* =========================================================
   EXTENSION ENTRY POINT
========================================================= */

// The `pi` reference is captured here so handlers and commands can call action
// methods (setModel, sendMessage, appendEntry). It is only valid after the
// runner binds its context, which happens during factory execution.
let pi: ExtensionAPI;

export default function (extensionPi: ExtensionAPI): void {
  pi = extensionPi;
  routerConfig = loadRouterConfig();
  state = { ...DEFAULT_STATE, history: [] };
  applyingRouterModel = false;
  authorizedTask = false;
  pendingDecision = null;
  modeRevision = 0;

  // Register the virtual AUTO model so it appears in Pi's existing /model
  // selector. `registerProvider` is queued at load and flushed once the model
  // registry is available, so this is safe without a /reload.
  //
  // The model is inert: every selector interaction with it is intercepted by
  // handleModelSelect and never results in a real provider request.
  try {
    pi.registerProvider(PROVIDER_AUTO, {
      baseUrl: "http://127.0.0.1:1234/v1",
      api: "openai-completions" as const,
      apiKey: "auto-router",
      models: [
        {
          id: MODEL_AUTO,
          name: "AUTO",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        },
      ],
    });
  } catch {
    /* provider may already be registered */
  }

  pi.on("model_select", handleModelSelect);
  pi.on("turn_start", handleTurnStart);
  pi.on("before_agent_start", handleBeforeAgentStart);
  pi.on("agent_end", () => {
    authorizedTask = false;
  });
  pi.on("turn_end", handleTurnEnd);
  pi.on("session_start", handleSessionStart);
  pi.on("input", handleInput);

  registerCommands();
}

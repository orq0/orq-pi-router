import { after } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import router from "../../index.ts";
import { DEFAULT_ROUTER_CONFIG } from "../../targets.ts";
import {
  type VonDecision,
  DEFAULT_VON_CONFIG,
  setVonConfigForTests,
  setVonClientFactoryForTests,
} from "../../von.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-router-tests-"));
const previous = process.env.PI_ROUTER_CONFIG;
after(() => {
  if (previous === undefined) delete process.env.PI_ROUTER_CONFIG;
  else process.env.PI_ROUTER_CONFIG = previous;
  setVonClientFactoryForTests(null);
  setVonConfigForTests(DEFAULT_VON_CONFIG);
  rmSync(dir, { recursive: true, force: true });
});
export const targets = [
  DEFAULT_ROUTER_CONFIG.targets[0],
  {
    id: "luna",
    name: "Luna",
    provider: "provider-b",
    model: "small/model",
    description: "Quick simple tasks",
  },
  {
    id: "sol",
    name: "Sol",
    provider: "provider-a",
    model: "coding-v2",
    description: "General implementation",
  },
  DEFAULT_ROUTER_CONFIG.targets[1],
];
export function setup(
  options: {
    unavailable?: string[];
    missing?: string[];
    reject?: boolean;
    targetList?: typeof targets;
    enabled?: boolean;
    beforeDecision?: () => Promise<void>;
    vonUrl?: string;
    timeoutMs?: number;
  } = {},
) {
  const configured = options.targetList ?? targets;
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      targets: configured,
    }),
  );
  process.env.PI_ROUTER_CONFIG = path;
  const events: Record<string, Function> = {};
  const commands: Record<string, any> = {};
  const messages: any[] = [];
  const switches: any[] = [];
  const entries: any[] = [];
  const branch: any[] = [];
  const models = configured.map((t) => ({
    provider: t.provider,
    id: t.model,
    api: "openai-completions",
    baseUrl: `https://${t.provider}.example/v1`,
    headers: { "x-test": "preserved" },
  }));
  let busy = false;
  let aborts = 0;
  const ctx: any = {
    isIdle: () => !busy,
    abort: () => {
      aborts += 1;
    },
    waitForIdle: async () => {},
    sessionManager: { getBranch: () => branch },
    modelRegistry: {
      find: (provider: string, id: string) =>
        models.find(
          (m) =>
            m.provider === provider &&
            m.id === id &&
            !options.missing?.includes(
              configured.find((t) => t.provider === provider && t.model === id)!
                .id,
            ),
        ),
      hasConfiguredAuth: (model: any) =>
        !options.unavailable?.includes(
          configured.find(
            (t) => t.provider === model.provider && t.model === model.id,
          )!.id,
        ),
    },
  };
  const pi: any = {
    on: (event: string, handler: Function) => {
      events[event] = handler;
    },
    registerCommand: (name: string, command: any) => {
      commands[name] = command;
    },
    registerProvider: () => {},
    sendMessage: (message: any) => messages.push(message),
    appendEntry: (_type: string, data: any) => entries.push(data),
    setModel: async (model: any) => {
      await Promise.resolve(); // Ensure callers await the asynchronous switch.
      if (options.reject) return false;
      switches.push(model);
      await events.model_select({ model }, ctx);
      return true;
    },
  };
  let winner = "sol";
  let fail = false;
  let response: VonDecision | undefined;
  const calls: any[] = [];
  setVonConfigForTests({
    ...DEFAULT_VON_CONFIG,
    enabled: options.enabled ?? true,
    url: options.vonUrl ?? DEFAULT_VON_CONFIG.url,
    timeoutMs: options.timeoutMs ?? DEFAULT_VON_CONFIG.timeoutMs,
  });
  setVonClientFactoryForTests(
    (config) =>
      ({
        decide: async () => {
          const ids = Object.keys(config.criteria);
          calls.push(config);
          await options.beforeDecision?.();
          if (fail) return null;
          if (response) return response;
          return {
            choice: winner.toUpperCase(),
            probabilities: Object.fromEntries(
              ids.map((id) => [
                id,
                id === winner.toUpperCase()
                  ? 0.9
                  : 0.1 / Math.max(1, ids.length - 1),
              ]),
            ),
            confidence: 0.9,
          };
        },
      }) as any,
  );
  // With a URL supplied, exercise the production HTTP client and parser.
  if (options.vonUrl) setVonClientFactoryForTests(null);
  router(pi);
  return {
    ctx,
    events,
    commands,
    messages,
    switches,
    entries,
    branch,
    models,
    calls,
    busy: (value: boolean) => {
      busy = value;
    },
    abortCount: () => aborts,
    choose: (id: string) => {
      winner = id;
    },
    respond: (decision: VonDecision) => {
      response = decision;
    },
    offline: () => {
      fail = true;
    },
    online: () => {
      fail = false;
    },
    state: () => entries.at(-1),
    turn: async (text: string, error?: string) => {
      const result = await events.input({ text }, ctx);
      if (result?.action === "handled") return result;
      const before = aborts;
      await events.before_agent_start(
        { messageType: "user", prompt: text },
        ctx,
      );
      if (aborts > before) return { action: "handled" };
      await events.turn_start({}, ctx);
      if (aborts > before) return { action: "handled" };
      await events.turn_end(
        {
          message: {
            role: "assistant",
            stopReason: error ? "error" : "stop",
            errorMessage: error,
          },
        },
        ctx,
      );
      await events.agent_end({}, ctx);
    },
  };
}

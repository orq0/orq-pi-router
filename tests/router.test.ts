import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DEFAULT_ROUTER_CONFIG } from "../targets.ts";
import { setup, targets } from "./helpers/router-harness.ts";

test("AUTO switches to each configured model and preserves complete provider configuration", async () => {
  const h = setup();
  for (const [i, t] of targets.entries()) {
    h.choose(t.id);
    await h.turn(`task ${i}`);
    assert.equal(h.switches.at(-1), h.models[i]);
    assert.equal(h.state().currentTarget, t.id);
    assert.equal(h.state().mode, "auto");
  }
  assert.deepEqual(Object.keys(h.calls[0].criteria), [
    "LOCAL",
    "LUNA",
    "SOL",
    "ASTRA",
  ]);
  assert.equal(h.calls[0].criteria.SOL, "General implementation");
});
test("AUTO excludes unauthenticated and missing registry models from Von candidates", async () => {
  const h = setup({ unavailable: ["astra"], missing: ["luna"] });
  await h.turn("general coding");
  assert.deepEqual(Object.keys(h.calls[0].criteria), ["LOCAL", "SOL"]);
  assert.equal(h.state().currentTarget, "sol");
});
test("manual command pins Sol; /auto resumes classification", async () => {
  const h = setup();
  await h.commands.router.handler("sol", h.ctx);
  assert.equal(h.state().mode, "sol");
  h.choose("luna");
  await h.turn("quick edit");
  assert.equal(h.calls.length, 0);
  assert.equal(h.state().currentTarget, "sol");
  await h.commands.auto.handler("", h.ctx);
  await h.turn("quick edit");
  assert.equal(h.state().currentTarget, "luna");
});
test("model selector pins configured and unconfigured provider models", async () => {
  const h = setup();
  await h.events.model_select({ model: h.models[2] }, h.ctx);
  assert.equal(h.state().mode, "sol");
  await h.turn("some task");
  assert.equal(h.calls.length, 0);
  await h.events.model_select(
    { model: { provider: "third-party", id: "another-model" } },
    h.ctx,
  );
  assert.equal(h.state().mode, "manual");
  await h.turn("another task");
  assert.equal(h.calls.length, 0);
  await h.events.model_select(
    { model: { provider: "auto-router", id: "auto-router" } },
    h.ctx,
  );
  await h.turn("resume routing");
  assert.equal(h.calls.length, 1);
});
test("Von owns the decision after repeated failures", async () => {
  const h = setup({ unavailable: ["luna"] });
  h.choose("local");
  for (let i = 0; i < 3; i++) await h.turn(`attempt ${i}`, "provider failed");
  assert.equal(h.state().consecutiveFailures, 3);
  const calls = h.calls.length;
  h.choose("astra");
  await h.turn("retry after failures");
  assert.equal(h.state().currentTarget, "astra");
  assert.equal(h.calls.length, calls + 1);
  assert.match(h.state().lastDecisionReason, /^von:/);
});
test("AUTO blocks instead of escalating when Von fails after repeated provider errors", async () => {
  const h = setup({ unavailable: ["luna"] });
  h.choose("local");
  for (let i = 0; i < 3; i++) await h.turn(`attempt ${i}`, "provider failed");
  h.offline();
  const before = h.switches.length;
  assert.deepEqual(await h.turn("retry after failures"), { action: "handled" });
  assert.equal(h.switches.length, before);
  assert.equal(h.state().currentTarget, "local");
  assert.equal(h.state().consecutiveFailures, 3);
  assert.match(h.messages.at(-1).content, /AUTO blocked/);
});
test("AUTO applies Von's weak ASTRA choice without a local probability override", async () => {
  const h = setup();
  h.respond({
    choice: "ASTRA",
    probabilities: { LOCAL: 0.2414, LUNA: 0.1574, SOL: 0.2204, ASTRA: 0.3808 },
    confidence: 0.1394,
  });
  await h.events.input({ text: "Analyze a cryptographic protocol" }, h.ctx);
  assert.equal(h.state().currentTarget, "astra");
  assert.equal(h.switches.at(-1), h.models[3]);
});
test("rejected model switches never commit the target or manual mode", async () => {
  const h = setup({ reject: true });
  await h.commands.router.handler("sol", h.ctx);
  assert.equal(h.state().currentTarget, null);
  assert.equal(h.state().mode, "auto");
  assert.match(h.state().lastFailure, /rejected/);
  assert.equal(h.switches.length, 0);
});
test("unavailable targets and unknown aliases report useful errors without switching", async () => {
  const h = setup({ unavailable: ["sol"] });
  await h.commands.router.handler("sol", h.ctx);
  assert.match(h.messages.at(-1).content, /not available/);
  await h.commands.router.handler("unknown", h.ctx);
  assert.match(h.messages.at(-1).content, /Unknown routing target/);
  await h.commands.router.handler("models", h.ctx);
  assert.match(
    h.messages.at(-1).content,
    /provider-a\/coding-v2 \(unavailable\)/,
  );
  assert.equal(h.switches.length, 0);
});
test("a malformed Von choice blocks AUTO instead of choosing any available model", async () => {
  const h = setup({ unavailable: ["local"] });
  h.choose("missing");
  assert.deepEqual(await h.turn("ambiguous request"), { action: "handled" });
  assert.equal(h.switches.length, 0);
  assert.equal(h.state().currentTarget, null);
  assert.match(h.messages.at(-1).content, /AUTO blocked/);
});
test("AUTO blocks every task while Von is offline, irrespective of task keywords", async () => {
  const h = setup({ targetList: [targets[1], targets[2]] });
  h.offline();
  for (const task of ["system design", "fix a bug"]) {
    assert.deepEqual(await h.turn(task), { action: "handled" });
    assert.equal(h.switches.length, 0);
  }
});
test("legacy commands work with the default two targets", async () => {
  const h = setup({ targetList: DEFAULT_ROUTER_CONFIG.targets });
  await h.commands.local.handler("", h.ctx);
  assert.equal(h.state().currentTarget, "local");
  await h.commands.astra.handler("", h.ctx);
  assert.equal(h.state().currentTarget, "astra");
});
test("no available targets reports status without creating a partial model", async () => {
  const h = setup({ unavailable: targets.map((t) => t.id) });
  await h.turn("work");
  assert.equal(h.switches.length, 0);
  assert.equal(h.calls.length, 0);
  assert.match(h.messages.at(-1).content, /No configured routing targets/);
});

test("a failed Von request is retried when the service recovers for the same task", async () => {
  const h = setup();
  h.offline();
  await h.turn("a task without keyword signals");
  assert.equal(h.state().currentTarget, null);
  assert.equal(h.switches.length, 0);
  h.online();
  h.choose("sol");
  await h.turn("a task without keyword signals");
  assert.equal(h.calls.length, 2);
  assert.equal(h.state().currentTarget, "sol");
});
test("each task is classified using currently available candidates", async () => {
  const unavailable: string[] = [];
  const h = setup({ unavailable });
  h.choose("sol");
  await h.turn("same task");
  unavailable.push("sol");
  h.choose("luna");
  await h.turn("same task");
  assert.equal(h.state().currentTarget, "luna");
  assert.deepEqual(Object.keys(h.calls.at(-1).criteria), [
    "LOCAL",
    "LUNA",
    "ASTRA",
  ]);
});
test("restoration clears a removed target alias and restores a configured alias", async () => {
  const h = setup();
  h.branch.push({
    type: "custom",
    customType: "router-state",
    data: { mode: "sol", currentTarget: "sol" },
  });
  await h.events.session_start({ reason: "resume" }, h.ctx);
  assert.equal(h.messages.at(-1).details.mode, "sol");
  assert.equal(h.messages.at(-1).details.currentTarget, "sol");
  h.branch.push({
    type: "custom",
    customType: "router-state",
    data: { mode: "removed", currentTarget: "removed" },
  });
  await h.events.session_start({ reason: "resume" }, h.ctx);
  assert.equal(h.messages.at(-1).details.mode, "auto");
  assert.equal(h.messages.at(-1).details.currentTarget, null);
  h.branch.length = 0;
  await h.events.session_start({ reason: "new" }, h.ctx);
  assert.equal(h.messages.at(-1).details.mode, "auto");
  assert.equal(h.messages.at(-1).details.currentTarget, null);
});

test("routing-only HTTP pipeline selects every target without calling task providers", async () => {
  const cases = [
    { task: "Make a small routine edit", target: "local" },
    { task: "Write a short explanation", target: "luna" },
    { task: "Implement a pagination endpoint", target: "sol" },
    {
      task: "Design a distributed authorization system",
      target: "astra",
      probabilities: {
        LOCAL: 0.2414,
        LUNA: 0.1574,
        SOL: 0.2204,
        ASTRA: 0.3808,
      },
    },
  ];
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    requests.push({ path: req.url, payload });
    const scenario = cases.find((c) => c.task === payload.state.task);
    const selected = scenario?.target;
    const choices: string[] = payload.questions.routing.options;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        answers: {
          routing: {
            choice: selected?.toUpperCase(),
            probabilities:
              scenario?.probabilities ??
              Object.fromEntries(
                choices.map((id) => [
                  id,
                  id === selected?.toUpperCase() ? 0.85 : 0.05,
                ]),
              ),
            confidence: 0.8,
          },
        },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  const origin = `http://127.0.0.1:${port}`;
  const originalFetch = globalThis.fetch;
  const attemptedProviderRequests: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin || url.pathname !== "/v1/systemone") {
      attemptedProviderRequests.push(url.origin);
      throw new Error(
        "A routing-only test must not call a task-model provider",
      );
    }
    return originalFetch(input, init);
  };
  try {
    for (const scenario of cases) {
      const h = setup({ vonUrl: origin });
      // Invoke only routing input. No agent turn or task execution follows.
      await h.events.input({ text: scenario.task }, h.ctx);
      const target = targets.find((t) => t.id === scenario.target)!;
      assert.equal(h.switches.length, 1);
      assert.equal(h.switches[0].provider, target.provider);
      assert.equal(h.switches[0].id, target.model);
      assert.equal(h.state().currentTarget, scenario.target);
      assert.match(h.state().lastDecisionReason, /^von:/);
    }
    assert.equal(requests.length, cases.length);
    for (const { path, payload } of requests) {
      assert.equal(path, "/v1/systemone");
      assert.deepEqual(payload.questions.routing.options, [
        "LOCAL",
        "LUNA",
        "SOL",
        "ASTRA",
      ]);
      assert.equal(
        payload.questions.routing.criteria.SOL,
        "General implementation",
      );
    }
    assert.deepEqual(attemptedProviderRequests, []);
  } finally {
    globalThis.fetch = originalFetch;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("new sessions default to AUTO and each task needs a fresh Von decision", async () => {
  const h = setup();
  await h.events.session_start({ reason: "new" }, h.ctx);
  assert.equal(h.messages.at(-1).details.mode, "auto");
  await h.turn("same task");
  h.offline();
  const before = h.switches.length;
  assert.deepEqual(await h.turn("same task"), { action: "handled" });
  assert.equal(h.switches.length, before);
  assert.equal(h.calls.length, 2);
});
test("all configured slash commands pin their model and bypass disabled Von", async () => {
  for (const target of targets) {
    const h = setup({ enabled: false });
    assert.ok(h.commands[target.id]);
    await h.commands[target.id].handler("", h.ctx);
    for (let i = 0; i < 4; i++)
      await h.turn(`manual task ${i}`, "provider failure");
    assert.equal(h.calls.length, 0);
    assert.equal(h.state().mode, target.id);
    assert.equal(h.state().currentTarget, target.id);
    assert.equal(h.switches.length, 1);
    assert.equal(h.switches[0].provider, target.provider);
    assert.equal(h.switches[0].id, target.model);
  }
});
test("AUTO blocks disabled Von; a manual command still works", async () => {
  const h = setup({ enabled: false });
  assert.deepEqual(await h.turn("task"), { action: "handled" });
  assert.equal(h.calls.length, 0);
  assert.equal(h.switches.length, 0);
  assert.match(h.messages.at(-1).content, /Von is disabled/);
  await h.commands.sol.handler("", h.ctx);
  await h.turn("task");
  assert.equal(h.state().mode, "sol");
  assert.equal(h.switches.length, 1);
  assert.equal(h.calls.length, 0);
});
test("rejected AUTO model selection consumes input instead of using a previous model", async () => {
  const h = setup({ reject: true });
  assert.deepEqual(await h.turn("task"), { action: "handled" });
  assert.equal(h.state().currentTarget, null);
  assert.equal(h.switches.length, 0);
  assert.match(h.messages.at(-1).content, /AUTO blocked/);
});
test("queued tasks are classified before queueing and switch at the next safe boundary", async () => {
  const h = setup();
  h.busy(true);
  h.choose("astra");
  await h.events.input({ text: "queued architecture task" }, h.ctx);
  assert.equal(h.calls.length, 1);
  assert.equal(h.switches.length, 0);
  await h.events.turn_start({}, h.ctx);
  assert.equal(h.state().currentTarget, "astra");
  assert.equal(h.switches.length, 1);
  assert.equal(h.abortCount(), 0);
});
test("a failed Von request while busy rejects the new task without aborting the active task", async () => {
  const h = setup();
  h.busy(true);
  h.offline();
  assert.deepEqual(await h.events.input({ text: "queued task" }, h.ctx), {
    action: "handled",
  });
  assert.equal(h.switches.length, 0);
  assert.equal(h.abortCount(), 0);
});
test("direct run triggers require Von; an unclassified turn is aborted", async () => {
  const h = setup();
  h.offline();
  await h.events.before_agent_start(
    { messageType: "user", prompt: "direct task" },
    h.ctx,
  );
  assert.equal(h.abortCount(), 1);
  assert.equal(h.switches.length, 0);
  const successful = setup();
  await successful.events.before_agent_start(
    { messageType: "custom", message: { content: "custom task" } },
    successful.ctx,
  );
  assert.equal(successful.state().currentTarget, "sol");
  assert.equal(successful.abortCount(), 0);
  const missing = setup();
  await missing.events.turn_start({}, missing.ctx);
  assert.equal(missing.abortCount(), 1);
  assert.equal(missing.switches.length, 0);
});
test("manual selection wins if it changes while Von is classifying", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = setup({ beforeDecision: () => pending });
  const input = h.events.input({ text: "task" }, h.ctx);
  await h.commands.local.handler("", h.ctx);
  release();
  await input;
  assert.equal(h.state().mode, "local");
  assert.equal(h.state().currentTarget, "local");
  assert.equal(h.switches.length, 1);
});
test("Pi model restore does not change the default AUTO mode", async () => {
  const h = setup();
  await h.events.model_select({ model: h.models[0], source: "restore" }, h.ctx);
  await h.events.session_start({ reason: "new" }, h.ctx);
  assert.equal(h.messages.at(-1).details.mode, "auto");
});
test("a target alias that collides with a Pi builtin remains available via /router", async () => {
  const h = setup({ targetList: [{ ...targets[2], id: "model" }] });
  assert.equal(h.commands.model, undefined);
  await h.commands.router.handler("model", h.ctx);
  assert.equal(h.state().mode, "model");
  assert.equal(h.calls.length, 0);
});

test("a second queued AUTO input cannot overwrite the first task's chosen model", async () => {
  const h = setup();
  h.busy(true);
  h.choose("astra");
  await h.events.input({ text: "first queued task" }, h.ctx);
  h.choose("luna");
  h.busy(false); // The first queued task still owns its decision between runs.
  assert.deepEqual(
    await h.events.input({ text: "second queued task" }, h.ctx),
    { action: "handled" },
  );
  await h.events.turn_start({}, h.ctx);
  assert.equal(h.state().currentTarget, "astra");
  assert.equal(h.calls.length, 1);
});
test("HTTP errors, malformed responses, and timeouts block AUTO before task execution", async () => {
  for (const outcome of ["http-error", "malformed", "timeout"]) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const server = createServer((_req, res) => {
      if (outcome === "timeout") {
        timer = setTimeout(() => res.end("{}"), 200);
        return;
      }
      res.statusCode = outcome === "http-error" ? 503 : 200;
      res.setHeader("content-type", "application/json");
      res.end(
        outcome === "malformed"
          ? "invalid json"
          : JSON.stringify({ detail: "classifier unavailable" }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as { port: number };
    try {
      const h = setup({
        vonUrl: `http://127.0.0.1:${port}`,
        timeoutMs: outcome === "timeout" ? 30 : 1000,
      });
      assert.deepEqual(
        await h.events.input({ text: "task" }, h.ctx),
        { action: "handled" },
        outcome,
      );
      assert.equal(h.switches.length, 0, outcome);
      assert.match(h.messages.at(-1).content, /AUTO blocked/, outcome);
    } finally {
      if (timer) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, targets } from "./router-harness.ts";
import { normalizeVonDecision } from "../../von.ts";

export interface LiveRoutingCase {
  name: string;
  task: string;
  expectedTarget?: string;
}

// The Pi boundary is a spy: no task-model request or credential is involved.
export function runLiveVonCases(title: string, cases: LiveRoutingCase[]) {
  test(title, async (t) => {
    const url = new URL(
      process.env.PI_ROUTER_TEST_VON_URL ?? "http://127.0.0.1:8100",
    );
    const timeoutMs = Number(
      process.env.PI_ROUTER_TEST_VON_TIMEOUT_MS ?? 15000,
    );
    assert.ok(
      Number.isFinite(timeoutMs) && timeoutMs > 0,
      "Use a positive finite Von timeout",
    );
    const originalFetch = globalThis.fetch;
    let answer: unknown;
    let classifierError = "";
    let requests = 0;
    globalThis.fetch = async (input, init) => {
      const requestUrl = new URL(
        input instanceof Request ? input.url : String(input),
      );
      assert.equal(
        requestUrl.origin,
        url.origin,
        "Only the configured Von origin may be contacted",
      );
      assert.equal(
        requestUrl.pathname,
        `${url.pathname.replace(/\/$/, "")}/v1/systemone`,
      );
      requests += 1;
      try {
        const response = await originalFetch(input, init);
        const body = await response.clone().json();
        if (!response.ok)
          classifierError = `Von HTTP ${response.status}: ${JSON.stringify(body)}`;
        answer = body?.answers?.routing;
        return response;
      } catch (error) {
        classifierError = (error as Error).message;
        throw error;
      }
    };
    try {
      for (const scenario of cases) {
        const task = scenario.task;
        await t.test(scenario.name, async () => {
          answer = undefined;
          classifierError = "";
          const h = setup({
            vonUrl: url.toString().replace(/\/$/, ""),
            timeoutMs,
          });
          await h.commands.auto.handler("", h.ctx);
          assert.equal(
            h.state().mode,
            "auto",
            "Every live task starts explicitly in AUTO",
          );
          await h.events.input({ text: task }, h.ctx);
          const decision = normalizeVonDecision(
            answer,
            targets.map((candidate) => candidate.id.toUpperCase()),
          );
          assert.ok(
            decision,
            classifierError ||
              "Von did not return a valid classification; load/warm its weights first",
          );
          assert.match(
            h.state()?.lastDecisionReason ?? "",
            /^von:/,
            "Deterministic fallback does not pass a live classifier test",
          );
          const expected = decision.choice.toLowerCase();
          const configured = targets.find(
            (candidate) => candidate.id === expected,
          )!;
          assert.equal(h.switches.length, 1);
          assert.equal(h.switches[0].provider, configured.provider);
          assert.equal(h.switches[0].id, configured.model);
          assert.equal(h.state().currentTarget, expected);
          t.diagnostic(
            `${scenario.name} → ${expected}; expected: ${scenario.expectedTarget ?? "routing consistency only"}; Von choice: ${decision.choice}; probabilities: ${JSON.stringify(decision.probabilities)}`,
          );
          if (scenario.expectedTarget) {
            assert.equal(
              expected,
              scenario.expectedTarget,
              "The selected model did not match the task's expected capability tier",
            );
          }
        });
      }
      assert.equal(
        requests,
        cases.length,
        "Exactly one classification request per task; no task execution",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

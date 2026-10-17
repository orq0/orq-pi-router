import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRoutingSnapshot,
  policyEngine,
  normalizeVonDecision,
  VonClient,
  DEFAULT_VON_CONFIG,
  loadVonConfig,
} from "../von.ts";

const choices = ["LOCAL", "LUNA", "SOL", "ASTRA"];
const decision = {
  choice: "SOL",
  probabilities: { LOCAL: 0.05, LUNA: 0.1, SOL: 0.8, ASTRA: 0.05 },
  confidence: 0.8,
};
test("normalizes arbitrary configured choices and rejects foreign/missing/invalid probabilities", () => {
  assert.deepEqual(normalizeVonDecision(decision, choices), decision);
  for (const invalid of [
    { ...decision, choice: "UNKNOWN" },
    { ...decision, probabilities: { SOL: 1 } },
    { ...decision, probabilities: { ...decision.probabilities, SOL: NaN } },
    { ...decision, probabilities: { ...decision.probabilities, SOL: 1.1 } },
    { ...decision, probabilities: { ...decision.probabilities, UNKNOWN: 0 } },
  ])
    assert.equal(normalizeVonDecision(invalid, choices), null);
});
test("decision validation passes through every configured Von choice", () => {
  for (const choice of choices) {
    const von = {
      ...decision,
      choice,
      probabilities: Object.fromEntries(choices.map((id) => [id, 0.25])),
    };
    assert.equal(policyEngine(von, { choices }).decision, choice);
  }
});
test("Von's low-confidence choice is authoritative even when another probability is higher", () => {
  const von = {
    choice: "ASTRA",
    probabilities: { LOCAL: 0.7, LUNA: 0.1, SOL: 0.1, ASTRA: 0.1 },
    confidence: 0,
  };
  assert.equal(policyEngine(von, { choices }).decision, "ASTRA");
  assert.equal(
    policyEngine(
      {
        ...von,
        probabilities: { LOCAL: 0.25, LUNA: 0.25, SOL: 0.25, ASTRA: 0.25 },
      },
      { choices },
    ).decision,
    "ASTRA",
  );
});
test("missing and malformed Von decisions return no selection", () => {
  assert.equal(policyEngine(null, { choices }).decision, null);
  assert.equal(
    policyEngine({ ...decision, choice: "UNKNOWN" }, { choices }).decision,
    null,
  );
  assert.equal(
    policyEngine({ ...decision, probabilities: { SOL: 1 } }, { choices })
      .decision,
    null,
  );
});
test("legacy binary choices and model snapshot remain supported", () => {
  assert.equal(
    policyEngine({
      choice: "ASTRA",
      probabilities: { LOCAL: 0.2, ASTRA: 0.8 },
      confidence: 0,
    }).decision,
    "ASTRA",
  );
  assert.equal(
    buildRoutingSnapshot({ currentTarget: "sol" }, "write code").currentModel,
    "SOL",
  );
});
test("real HTTP adapter sends dynamic criteria and accepts a multi-model response", async () => {
  let payload: any;
  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/v1/systemone");
    let body = "";
    for await (const chunk of req) body += chunk;
    payload = JSON.parse(body);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ answers: { routing: decision } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address() as { port: number };
    const criteria = Object.fromEntries(
      choices.map((id) => [id, `${id} task description`]),
    );
    const client = new VonClient({
      ...DEFAULT_VON_CONFIG,
      url: `http://127.0.0.1:${address.port}`,
      criteria,
    });
    assert.deepEqual(
      await client.decide(
        buildRoutingSnapshot({ currentTarget: "luna" }, "debug code"),
      ),
      decision,
    );
    assert.deepEqual(payload.questions.routing.options, choices);
    assert.deepEqual(payload.questions.routing.criteria, criteria);
    assert.equal(payload.questions.routing.type, "choice");
    assert.equal(payload.state.currentModel, "LUNA");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("configuration reads URL paths, supports criteria, and ignores obsolete thresholds", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-von-"));
  const previous = process.env.PI_ROUTER_VON_CONFIG;
  try {
    delete process.env.PI_ROUTER_VON_CONFIG;
    assert.equal(loadVonConfig().timeoutMs, 5000); // checked-in URL path
    const path = join(dir, "von.json");
    writeFileSync(
      path,
      JSON.stringify({
        enabled: true,
        timeoutMs: 1234,
        clearChoiceThreshold: 0.99,
        clearAstraThreshold: 0.99,
        criteria: { SOL: "General coding", LUNA: "Simple work" },
      }),
    );
    process.env.PI_ROUTER_VON_CONFIG = path;
    assert.equal(loadVonConfig().criteria.SOL, "General coding");
    assert.equal(loadVonConfig().timeoutMs, 1234);
    assert.ok(!("clearChoiceThreshold" in loadVonConfig()));
    assert.ok(!("clearAstraThreshold" in loadVonConfig()));
    assert.equal(loadVonConfig().enabled, true);
  } finally {
    if (previous === undefined) delete process.env.PI_ROUTER_VON_CONFIG;
    else process.env.PI_ROUTER_VON_CONFIG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ROUTER_CONFIG,
  loadRouterConfig,
  validateRouterConfig,
} from "../targets.ts";

const target = {
  id: "sol",
  provider: "other-provider",
  model: "custom/model-v2",
  description: "General coding",
};
test("accepts provider-independent target references", () => {
  const result = validateRouterConfig({ targets: [target] });
  assert.equal(result.targets[0].model, "custom/model-v2");
});
test("rejects empty, duplicate, or invalid target definitions", () => {
  for (const config of [
    { targets: [] },
    { targets: [target, target] },
    { targets: [{ ...target, id: "auto" }] },
    { targets: [{ ...target, id: "router" }] },
    { targets: [{ ...target, id: "SOL" }] },
    { targets: [{ ...target, provider: "auto-router" }] },
    { targets: [{ ...target, description: "" }] },
    { targets: [target, { ...target, id: "luna" }] },
  ])
    assert.throws(() => validateRouterConfig(config));
});
test("legacy defaults remain local/model and openai/gpt-6-astra", () => {
  assert.deepEqual(
    validateRouterConfig(DEFAULT_ROUTER_CONFIG).targets.map((t) => [
      t.provider,
      t.model,
    ]),
    [
      ["local", "model"],
      ["openai", "gpt-6-astra"],
    ],
  );
});
test("loads an explicit config and fails visibly for corrupt or missing files", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-targets-"));
  try {
    const path = join(dir, "router.json");
    writeFileSync(path, JSON.stringify({ targets: [target] }));
    assert.equal(loadRouterConfig(path).targets[0].id, "sol");
    writeFileSync(path, "{broken");
    assert.throws(() => loadRouterConfig(path), /Invalid router config/);
    assert.throws(() => loadRouterConfig(join(dir, "absent")), /Cannot read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

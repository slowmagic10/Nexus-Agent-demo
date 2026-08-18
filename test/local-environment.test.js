import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadLocalEnvironment } from "../src/local-environment.js";

test("通用本地配置优先于旧厂商配置且不覆盖进程环境", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nexus-local-env-"));
  try {
    writeFileSync(path.join(root, ".env.local"), "OPENAI_API_KEY=generic-key\nOPENAI_MODEL=generic-model\n");
    writeFileSync(path.join(root, ".env.deepseek.local"), "OPENAI_API_KEY=legacy-key\n");
    const env = { OPENAI_MODEL: "shell-model" };

    const loaded = loadLocalEnvironment(root, { env });

    assert.equal(path.basename(loaded.file), ".env.local");
    assert.equal(loaded.legacy, false);
    assert.equal(env.OPENAI_API_KEY, "generic-key");
    assert.equal(env.OPENAI_MODEL, "shell-model");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("没有通用配置时自动读取旧配置以保留现有密钥", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nexus-legacy-env-"));
  try {
    writeFileSync(path.join(root, ".env.deepseek.local"), "OPENAI_API_KEY='legacy-key'\nNEXUS_MAX_STEPS=unlimited # comment\n");
    const env = {};

    const loaded = loadLocalEnvironment(root, { env });

    assert.equal(loaded.legacy, true);
    assert.equal(env.OPENAI_API_KEY, "legacy-key");
    assert.equal(env.NEXUS_MAX_STEPS, "unlimited");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

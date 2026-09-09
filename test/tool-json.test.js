import assert from "node:assert/strict";
import test from "node:test";
import { redactSensitiveText, redactSensitiveValue } from "../src/security/redact.js";
import { serializeRedactedToolJson } from "../src/security/tool-json.js";

test("已按值脱敏的工具JSON经多次文本脱敏仍可解析且数据不变", () => {
  const safe = redactSensitiveValue({
    password: "private password",
    env: "API_KEY=private-token",
    header: "authorization: bearer private-token",
    ssh: 'sshpass -p "private-pass" ssh host',
    expect: 'expect script user host "private-pass"',
    chinese: '登录密码是"private-pass"',
    nested: [{ text: '😀 quoted "text" = : - literal \\u003d' }],
  });
  let encoded = serializeRedactedToolJson(safe);
  assert.deepEqual(JSON.parse(encoded), safe);
  for (let i = 0; i < 3; i += 1) {
    encoded = redactSensitiveText(encoded);
    assert.deepEqual(JSON.parse(encoded), safe);
  }
  assert.equal(encoded.includes("private-token"), false);
  assert.equal(encoded.includes("private-pass"), false);
});

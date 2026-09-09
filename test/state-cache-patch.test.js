import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { applyStatePatch } from "../src/state-patch.js";
import { compileStateCachePatch } from "../src/persistence/state-cache-patch.js";

function executePatch(state, patch) {
  const compiled = compileStateCachePatch(patch);
  assert.ok(compiled, "patch should have an incremental SQLite translation");
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE cache (state_json TEXT)");
    database.prepare("INSERT INTO cache (state_json) VALUES (?)").run(JSON.stringify(state));
    database.prepare(`UPDATE cache SET state_json = ${compiled.expression}`).run(...compiled.params);
    const { state_json: value } = database.prepare("SELECT state_json FROM cache").get();
    return value === null ? null : JSON.parse(value);
  } finally {
    database.close();
  }
}

function assertEquivalent(state, patch) {
  assert.deepEqual(executePatch(state, patch), applyStatePatch(state, patch));
}

test("空状态补丁直接保留原 JSON 列且不绑定参数", () => {
  for (const patch of [{}, { set: {} }, { append: {} }, { remove: [] }, { set: {}, append: {}, remove: [] }]) {
    assert.deepEqual(compileStateCachePatch(patch), { expression: "state_json", params: [] });
    assertEquivalent({ messages: [], retained: null }, patch);
  }
});

test("状态补丁保留所有 JSON 值类型以及原有字段", () => {
  const values = [null, false, true, "", "中文🙂", 0, 1, -19, 1.25, 1e300, [], {}, [1, false, null], { nested: { count: 3 }, empty: [] }];
  for (const value of values) assertEquivalent({ retained: { count: 2 }, value: "old" }, { set: { value } });
});

test("状态补丁严格按 remove、set、append 顺序执行", () => {
  assertEquivalent({ removed: true, value: "not-array", retained: 4 }, {
    remove: ["removed", "value", "absent"],
    set: { value: ["seed"], other: [] },
    append: { value: [null, false, 2, "tail", [3], { key: "value" }], other: [true] },
  });
  assertEquivalent({ items: [1, 2] }, { append: { items: [3, 4, 5] } });
  assertEquivalent({ items: [] }, { append: { items: [] } });
});

test("状态补丁字符串均作为 JSON 参数绑定，不能注入 SQL 或 JSON 路径", () => {
  const content = "'); DROP TABLE cache; -- $.secret[#] \\ \" : null\n[REDACTED]";
  const patch = { set: { items: [content], value: content }, append: { items: [content] } };
  const compiled = compileStateCachePatch(patch);
  assert.ok(compiled.params.some((value) => JSON.parse(value) === content));
  assert.equal(compiled.expression.includes("DROP TABLE"), false);
  assertEquivalent({ retained: "safe" }, patch);
});

test("状态补丁支持空值和对象追加而不会将它们转成字符串", () => {
  assertEquivalent({ items: ["old"] }, { append: { items: [null, true, false, 0, "", [], {}, { nested: [null] }] } });
});

test("状态补丁检测不存在或非数组的追加目标，包含空追加", () => {
  for (const state of [{}, { items: null }, { items: {} }, { items: "[]" }, { items: 1 }, { items: false }]) {
    for (const items of [[], [1]]) {
      const patch = { append: { items } };
      assert.throws(() => applyStatePatch(state, patch), /非数组/);
      assert.equal(executePatch(state, patch), null);
    }
  }
  assert.equal(executePatch({ items: [1] }, { remove: ["items"], append: { items: [2] } }), null);
  assert.equal(executePatch({ items: [1] }, { set: { items: null }, append: { items: [] } }), null);
});

test("任一追加目标无效时整份缓存补丁失败，不留下部分修改", () => {
  const patch = { set: { phase: "changed" }, append: { good: [1], missing: [2] } };
  assert.equal(executePatch({ phase: "old", good: [] }, patch), null);
});

test("状态补丁拒绝不安全或具有 JS 原型语义的顶层字段", () => {
  for (const key of ["a.b", "a[0]", "", "中文", "a-b", "a'b", "a\"b", "0start", "__proto__", "a\n"]) {
    for (const patch of [{ set: { [key]: 1 } }, { append: { [key]: [] } }, { remove: [key] }]) {
      assert.equal(compileStateCachePatch(patch), null, key);
    }
  }
  assertEquivalent({}, { set: { _allowed_12: "yes", constructor: 2, toString: false } });
});

test("状态补丁拒绝非法 patch shape 和非数组 append", () => {
  for (const patch of [null, undefined, [], 3, "{}", true, { unknown: {} }, { set: null }, { set: [] }, { append: null }, { append: [] }, { remove: null }, { remove: "x" }, { remove: [1] }, { append: { items: {} } }, { append: { items: "x" } }, { set: undefined }, { append: undefined }, { remove: undefined }]) {
    assert.equal(compileStateCachePatch(patch), null);
  }
});

test("状态补丁拒绝无法无损保存的 JS 值，不忽略嵌套非法成员", () => {
  const cyclic = {}; cyclic.self = cyclic;
  const sparse = []; sparse.length = 1;
  const customArray = []; customArray.extra = 2;
  const accessor = Object.defineProperty({}, "x", { enumerable: true, get() { throw new Error("must not invoke"); } });
  const symbolObject = { [Symbol("hidden")]: true };
  const hidden = Object.defineProperty({}, "hidden", { value: 2 });
  const values = [undefined, NaN, Infinity, -Infinity, -0, 1n, () => 1, Symbol("x"), new Date(), new Map(), new Set(), /a/, cyclic, sparse, customArray, accessor, symbolObject, hidden];
  for (const value of values) {
    assert.equal(compileStateCachePatch({ set: { value } }), null);
    assert.equal(compileStateCachePatch({ set: { value: { child: value } } }), null);
    assert.equal(compileStateCachePatch({ append: { items: [value] } }), null);
  }
  const child = { value: 1 };
  assertEquivalent({ items: [] }, { append: { items: [child, child] } });
});

test("状态补丁拒绝 patch 容器上的访问器和符号字段", () => {
  const patch = Object.defineProperty({}, "set", { enumerable: true, get() { throw new Error("must not invoke"); } });
  assert.equal(compileStateCachePatch(patch), null);
  assert.equal(compileStateCachePatch({ [Symbol("hidden")]: true }), null);
  const nullable = Object.create(null); nullable.set = Object.create(null); nullable.set.count = 1;
  assertEquivalent({}, nullable);
});

test("128 操作边界保持所有修改并分组兼容旧 SQLite 函数参数上限", () => {
  const set = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`field_${index}`, { index }]));
  const compiled = compileStateCachePatch({ set });
  assert.equal((compiled.expression.match(/json_set\(/g) || []).length, 5);
  assert.equal(compiled.params.length, 128);
  assertEquivalent({}, { set });
  assert.equal(compileStateCachePatch({ set: { ...set, excess: 1 } }), null);
  assertEquivalent(set, { remove: Object.keys(set) });
  assert.equal(compileStateCachePatch({ remove: [...Object.keys(set), "excess"] }), null);
  assertEquivalent({ items: [] }, { append: { items: Array.from({ length: 127 }, (_, index) => index) } });
  assert.equal(compileStateCachePatch({ append: { items: Array.from({ length: 128 }, (_, index) => index) } }), null);
});

test("批量追加和多种操作共同受 128 上限约束", () => {
  const state = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`items_${index}`, []]));
  assertEquivalent(state, { append: state });
  assert.equal(compileStateCachePatch({ append: { ...state, excess: [] } }), null);
  const patch = { remove: Array.from({ length: 30 }, (_, index) => `old_${index}`), set: { items: ["seed"] }, append: { items: Array.from({ length: 96 }, (_, index) => index) } };
  assertEquivalent({}, patch);
  assert.equal(compileStateCachePatch({ ...patch, set: { ...patch.set, excess: true } }), null);
});

test("状态补丁对过深 JSON 退回完整保存", () => {
  let value = null;
  for (let index = 0; index < 120; index += 1) value = { child: value };
  assert.equal(compileStateCachePatch({ set: { value } }), null);
});

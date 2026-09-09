import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createStatePatch, applyStatePatch } from "../src/state-patch.js";
import { compileStateCachePatch } from "../src/persistence/state-cache-patch.js";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";

// Frozen reference implementation from before the equality optimization. Keep
// this independent of the production comparator, including JSON's exceptions
// and its observable getter/toJSON calls.
function originalCreateStatePatch(previous, next) {
  const patch = { set: {}, append: {}, remove: [] };
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const isPrefix = (before, after) => before.length <= after.length
    && before.every((value, index) => sameValue(value, after[index]));
  for (const key of keys) {
    if (!(key in next)) {
      patch.remove.push(key);
      continue;
    }
    if (sameValue(previous[key], next[key])) continue;
    if (Array.isArray(previous[key]) && Array.isArray(next[key]) && isPrefix(previous[key], next[key])) {
      patch.append[key] = structuredClone(next[key].slice(previous[key].length));
      continue;
    }
    patch.set[key] = structuredClone(next[key]);
  }
  if (!Object.keys(patch.set).length) delete patch.set;
  if (!Object.keys(patch.append).length) delete patch.append;
  if (!patch.remove.length) delete patch.remove;
  return patch;
}

function outcome(compare, makeCase) {
  const { previous, next, calls = [] } = makeCase();
  try {
    return { patch: compare(previous, next), calls };
  } catch (error) {
    return { error: { name: error.name, message: error.message }, calls };
  }
}

function assertOracle(makeCase, label = "") {
  const expected = outcome(originalCreateStatePatch, makeCase);
  const actual = outcome(createStatePatch, makeCase);
  assert.deepEqual(actual, expected, label);
  return actual;
}

test("状态补丁保留 JSON 键的插入顺序与数字键的原生排序", () => {
  const pairs = [
    [{ a: 1, b: 2 }, { b: 2, a: 1 }],
    [Object.fromEntries([["12", "x"], ["2", "y"], ["a", true]]),
      Object.fromEntries([["a", true], ["2", "y"], ["12", "x"]])],
    [{ "02": "x", a: 1 }, { a: 1, "02": "x" }],
    [{ nested: { a: 1, b: 2 } }, { nested: { b: 2, a: 1 } }],
  ];
  for (const [value, nextValue] of pairs) {
    assertOracle(() => ({ previous: { value }, next: { value: nextValue } }));
  }
  assert.deepEqual(createStatePatch({ value: pairs[0][0] }, { value: pairs[0][1] }), { set: { value: pairs[0][1] } });
  assert.deepEqual(createStatePatch({ value: pairs[1][0] }, { value: pairs[1][1] }), {});
});

test("状态补丁混合 set、append、remove 及数组替换时保持原协议", () => {
  const previous = { deleted: 1, phase: "thinking", items: [{ x: 1 }], clear: [1], stable: { a: [false] } };
  const next = { phase: "executing", items: [{ x: 1 }, { x: 2 }], clear: [], stable: { a: [false] }, added: null };
  const actual = assertOracle(() => ({ previous, next }));
  assert.deepEqual(actual.patch, {
    set: { phase: "executing", clear: [], added: null }, append: { items: [{ x: 2 }] }, remove: ["deleted"],
  });
  assert.deepEqual(applyStatePatch(previous, actual.patch), next);
  assertOracle(() => ({ previous: { items: [{ x: 1 }, 2] }, next: { items: [{ x: 3 }, 2, 4] } }));
});

test("长字符串和长历史前缀保持逐项追加及末尾差异判定", () => {
  const text = "中文🙂\\\"\n\u0000\ud800".repeat(1024);
  const history = Array.from({ length: 360 }, (_, index) => ({ index, content: `${text}${index}` }));
  const appended = assertOracle(() => ({ previous: { history }, next: { history: [...history, { index: 360, content: text }] } }));
  assert.deepEqual(appended.patch, { append: { history: [{ index: 360, content: text }] } });
  const changed = structuredClone(history);
  changed.at(-1).content += "changed";
  const replaced = assertOracle(() => ({ previous: { history }, next: { history: changed } }));
  assert.ok(replaced.patch.set.history);
});

test("null、负零、非有限数和 undefined 保持 JSON 等值规则", () => {
  const pairs = [[-0, 0], [NaN, null], [Infinity, -Infinity], [undefined, undefined],
    [{ value: undefined }, {}], [{ value: NaN }, { value: null }],
    [[undefined, NaN, -0], [null, null, 0]], [{ optional: undefined, kept: 1 }, { kept: 1 }],
    [{ value: () => 1 }, {}], [{ value: Symbol("ignored") }, {}], ["null", null]];
  for (const [value, nextValue] of pairs) {
    assertOracle(() => ({ previous: { value }, next: { value: nextValue } }));
  }
  assertOracle(() => ({ previous: {}, next: { optional: undefined } }));
  assertOracle(() => ({ previous: { optional: undefined }, next: {} }));
  assertOracle(() => ({ previous: { value: "before" }, next: { value: () => 1 } }));
});

test("稀疏数组、数组附加属性与符号属性保留旧 JSON 行为", () => {
  const hole = new Array(2);
  const extra = [1, 2]; extra.metadata = "ignored";
  const symbol = Symbol("metadata");
  const value = { kept: 1, [symbol]: "ignored" };
  const hidden = Object.defineProperty({ kept: 1 }, "hidden", { value: 2 });
  for (const [before, after] of [[hole, [null, null]], [hole, [...hole, 3]], [extra, [1, 2]],
    [value, { kept: 1 }], [hidden, { kept: 1 }]]) {
    assertOracle(() => ({ previous: { value: before }, next: { value: after } }));
  }
});

test("Date、boxed primitive、非标准原型和共享非循环子树保持原行为", () => {
  const values = [new Date("2026-09-09T00:00:00Z"), new Number(2), new String("boxed"),
    new Boolean(false), /pattern/u, new Map([["a", 1]]), new Set([1]),
    Object.assign(Object.create(null), { value: 1 }), Object.assign(Object.create({ inherited: 2 }), { value: 1 })];
  for (const value of values) {
    assertOracle(() => ({ previous: { value }, next: { value: JSON.parse(JSON.stringify(value)) } }));
  }
  const shared = { body: [1, { text: "shared" }] };
  assertOracle(() => ({ previous: { value: { left: shared, right: shared } },
    next: { value: { left: structuredClone(shared), right: structuredClone(shared) } } }));
});

test("JSON.rawJSON 保留原始 JSON 等值语义、嵌套行为和克隆异常", {
  skip: typeof JSON.rawJSON !== "function" ? "当前 Node 尚不支持 JSON.rawJSON" : false,
}, () => {
  const unchanged = assertOracle(() => ({ previous: { value: JSON.rawJSON("123") }, next: { value: 123 } }));
  assert.deepEqual(unchanged.patch, {});
  const changed = assertOracle(() => ({ previous: { value: JSON.rawJSON("123") }, next: { value: { rawJSON: "123" } } }));
  assert.deepEqual(changed.patch, { set: { value: { rawJSON: "123" } } });
  assertOracle(() => ({ previous: { value: 123 }, next: { value: JSON.rawJSON("456") } }));
  assertOracle(() => ({ previous: { value: { nested: [JSON.rawJSON("true"), JSON.rawJSON("null")] } },
    next: { value: { nested: [true, null] } } }));
  assertOracle(() => ({ previous: { value: [] }, next: { value: [JSON.rawJSON("123")] } }));
  const invalid = assertOracle(() => ({ previous: { value: { earlier: 1, nested: JSON.rawJSON("123"), failure: 1n } },
    next: { value: { earlier: 2, nested: 123, failure: null } } }));
  assert.equal(invalid.error?.name, "TypeError");
});

test("getter 和 toJSON 的调用顺序、次数和异常与旧比较完全相同", () => {
  const makeCase = () => {
    const calls = [];
    const before = Object.defineProperty({ unequal: 1 }, "value", {
      enumerable: true, get() { calls.push("before getter"); return 4; },
    });
    const after = Object.defineProperty({ unequal: 2 }, "value", {
      enumerable: true, get() { calls.push("after getter"); return 4; },
    });
    return { previous: { value: before }, next: { value: after }, calls };
  };
  assertOracle(makeCase);
  assertOracle(() => {
    const calls = [];
    const value = (side) => ({ toJSON(key) { calls.push(`${side} toJSON:${key}`); return { visible: 3 }; } });
    return { previous: { value: value("before") }, next: { value: value("after") }, calls };
  });
  assertOracle(() => {
    const calls = [];
    const value = Object.defineProperty({}, "toJSON", { get() {
      calls.push("toJSON getter"); return () => { calls.push("toJSON call"); return 3; };
    } });
    return { previous: { value }, next: { value: 3 }, calls };
  });
  assertOracle(() => ({ previous: { value: { before: true, get failure() { throw new Error("getter failure"); } } },
    next: { value: { before: false } } }));
});

test("toJSON 在兄弟字段已不同、键数不等或类型不同时仍按原顺序执行", () => {
  for (const scenario of ["value", "keys", "type"]) {
    assertOracle(() => {
      const calls = [];
      const nested = { toJSON() { calls.push("nested toJSON"); return "serialized"; } };
      const previous = { value: { first: 1, nested } };
      const next = { value: scenario === "type" ? "different type"
        : scenario === "keys" ? { first: 2 } : { first: 2, nested: "serialized" } };
      return { previous, next, calls };
    }, scenario);
  }
});

test("Proxy 的 get 投影与 toJSON trap 由原生 JSON 决定且不新增可见探测", () => {
  assertOracle(() => {
    const calls = [];
    const value = new Proxy({ projected: 1 }, {
      get(target, key, receiver) { calls.push(`get:${String(key)}`); return key === "projected" ? 2 : Reflect.get(target, key, receiver); },
      ownKeys(target) { calls.push("ownKeys"); return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor(target, key) { calls.push(`descriptor:${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key); },
      getPrototypeOf(target) { calls.push("getPrototypeOf"); return Reflect.getPrototypeOf(target); },
    });
    return { previous: { value }, next: { value: { projected: 2 } }, calls };
  });
  assertOracle(() => {
    const calls = [];
    const value = new Proxy({ hidden: "target" }, {
      get(target, key, receiver) {
        calls.push(`get:${String(key)}`);
        return key === "toJSON" ? (jsonKey) => { calls.push(`toJSON:${jsonKey}`); return { visible: true }; }
          : Reflect.get(target, key, receiver);
      },
    });
    return { previous: { value: { different: 1, nested: value } },
      next: { value: { different: 2, nested: { visible: true } } }, calls };
  });
  assertOracle(() => {
    const calls = [];
    const value = new Proxy([1, 2], {
      get(target, key, receiver) { calls.push(`array get:${String(key)}`); return key === "1" ? 3 : Reflect.get(target, key, receiver); },
    });
    return { previous: { value }, next: { value: [1, 3] }, calls };
  });
});

test("revoked Proxy 保留原异常且不能被早先不等值短路隐藏", () => {
  for (const position of ["left", "right"]) {
    const result = assertOracle(() => {
      const { proxy, revoke } = Proxy.revocable({ value: 1 }, {});
      revoke();
      const dangerous = { earlier: 1, nested: proxy };
      const safe = { earlier: 2, nested: null };
      return { previous: { value: position === "left" ? dangerous : safe },
        next: { value: position === "left" ? safe : dangerous } };
    });
    assert.equal(result.error?.name, "TypeError");
  }
});

test("循环和 BigInt 不会被前面已发现的不等值、不同长度或不同类型掩盖", () => {
  const hazards = [() => 1n, () => { const value = {}; value.self = value; return value; }];
  for (const hazard of hazards) {
    for (const position of ["left", "right"]) {
      for (const shape of ["object", "keys", "type", "array"]) {
        const actual = assertOracle(() => {
          const dangerous = shape === "array" ? [1, hazard()] : { different: 1, later: hazard() };
          const safe = shape === "array" ? [2] : shape === "keys" ? { different: 2 }
            : shape === "type" ? null : { different: 2, later: null };
          return { previous: { value: position === "left" ? dangerous : safe },
            next: { value: position === "left" ? safe : dangerous } };
        }, `${position} ${shape}`);
        assert.equal(actual.error?.name, "TypeError");
      }
    }
  }
});

test("同一对象身份也不能跳过 JSON 循环或 BigInt 异常", () => {
  for (const makeValue of [() => ({ value: 1n }), () => { const value = []; value.push(value); return value; }]) {
    const actual = assertOracle(() => {
      const value = makeValue();
      return { previous: { value }, next: { value } };
    });
    assert.equal(actual.error?.name, "TypeError");
  }
});

test("深层和宽对象在比较预算边界之外仍保留旧结果", () => {
  let deep = { value: "tail" };
  for (let depth = 0; depth < 220; depth += 1) deep = { child: deep };
  const wide = Array.from({ length: 18_000 }, (_, index) => ({ index, text: `value ${index}` }));
  for (const value of [deep, wide]) {
    assertOracle(() => ({ previous: { value }, next: { value: structuredClone(value) } }));
    assertOracle(() => ({ previous: { value }, next: { value: { changed: true, original: value } } }));
  }
});

test("新补丁内容与两个输入以及重放结果继续完全隔离", () => {
  const previous = { history: [{ text: "before" }], settings: { flag: false } };
  const next = { history: [{ text: "before" }, { nested: { text: "after" } }], settings: { flag: true } };
  const beforeSnapshot = structuredClone(previous);
  const nextSnapshot = structuredClone(next);
  const patch = createStatePatch(previous, next);
  const replayed = applyStatePatch(previous, patch);
  assert.deepEqual(replayed, next);
  patch.append.history[0].nested.text = "patch mutation";
  patch.set.settings.flag = "patch mutation";
  replayed.history[0].text = "replay mutation";
  assert.deepEqual(previous, beforeSnapshot);
  assert.deepEqual(next, nextSnapshot);
  assert.equal(replayed.history[1].nested.text, "after");
  next.history[1].nested.text = "input mutation";
  assert.equal(patch.append.history[0].nested.text, "patch mutation");
});

test("600 组确定性 JSON 状态变更逐个与冻结参考实现比较", () => {
  const random = seededRandom(0x7d994bf1);
  for (let iteration = 0; iteration < 600; iteration += 1) {
    const previous = { stable: randomValue(random), history: Array.from({ length: Math.floor(random() * 8) }, () => randomValue(random)),
      changed: randomValue(random), removed: randomValue(random) };
    const next = structuredClone(previous);
    if (iteration % 2 === 0) next.history.push(randomValue(random), randomValue(random));
    else if (next.history.length) next.history[Math.floor(random() * next.history.length)] = randomValue(random);
    if (iteration % 3 === 0) next.changed = randomValue(random);
    if (iteration % 4 === 0) delete next.removed;
    if (iteration % 5 === 0) next.added = randomValue(random);
    const expected = originalCreateStatePatch(previous, next);
    assert.deepEqual(createStatePatch(previous, next), expected, `seeded case ${iteration}`);
    assert.deepEqual(applyStatePatch(previous, expected), next, `replay case ${iteration}`);
  }
});

test("等价比较产生的真实 Session 历史补丁与原版逐步一致", async () => {
  const at = "2026-09-09T01:00:00.000Z";
  const state = createSession({ provider: "demo", workspace: "/tmp", createdAt: at, id: "patch-equality" });
  const session = new AgentSession({ state, reducer: reduceSession });
  const observed = [];
  session.subscribeEvents((event) => observed.push(event));
  const call = { id: "read-1", name: "read_file", arguments: { path: "README.md" } };
  const actions = [
    { type: "USER_MESSAGE", content: "读取项目并解释结构" }, { type: "MODEL_REQUESTED" },
    { type: "MODEL_STREAM_STARTED" }, { type: "MODEL_STREAM_DELTA", delta: "开始读取" },
    { type: "MODEL_STREAM_DELTA", delta: "项目结构。" }, { type: "MODEL_STREAM_COMPLETED" },
    { type: "ASSISTANT_MESSAGE", message: { role: "assistant", content: "读取文件" } },
    { type: "TOOL_REQUESTED", call, effects: ["read"] }, { type: "TOOL_EXECUTION_STARTED", call },
    { type: "TOOL_OUTPUT_UPDATED", callId: call.id, preview: "项目说明", capturedChars: 4, channel: "stdout" },
    { type: "TOOL_RESULT", call, ok: true, result: "项目说明", durationMs: 2 },
  ];
  let previous = state;
  for (const action of actions) {
    const next = await session.dispatch({ ...action, at });
    assert.deepEqual(observed.at(-1).patch, originalCreateStatePatch(previous, next), action.type);
    assert.deepEqual(applyStatePatch(previous, observed.at(-1).patch), next, action.type);
    previous = next;
  }
});

test("增量 SQLite 编译和缓存应用继续接受相同状态补丁", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE cache (state_json TEXT NOT NULL)");
    let state = { phase: "idle", history: [{ role: "user", content: "说明项目" }], settings: { enabled: true }, removed: null };
    database.prepare("INSERT INTO cache (state_json) VALUES (?)").run(JSON.stringify(state));
    const steps = [
      { ...state, phase: "thinking", history: [...state.history, { role: "assistant", content: "开始" }] },
      { phase: "idle", history: [], settings: { enabled: false }, added: [1, 2, 3] },
    ];
    for (const next of steps) {
      const patch = createStatePatch(state, next);
      const expected = originalCreateStatePatch(state, next);
      assert.deepEqual(compileStateCachePatch(patch), compileStateCachePatch(expected));
      const compiled = compileStateCachePatch(patch);
      assert.ok(compiled);
      database.prepare(`UPDATE cache SET state_json = ${compiled.expression}`).run(...compiled.params);
      assert.deepEqual(JSON.parse(database.prepare("SELECT state_json FROM cache").get().state_json), next);
      state = next;
    }
  } finally {
    database.close();
  }
});

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 0x1_0000_0000; };
}

function randomValue(random, depth = 0) {
  const choice = Math.floor(random() * (depth > 3 ? 5 : 7));
  if (choice === 0) return null;
  if (choice === 1) return random() < 0.5;
  if (choice === 2) return Math.floor(random() * 2_000) - 1_000;
  if (choice === 3) return random() * 100;
  if (choice === 4) return ["", "中文🙂", "quote\"\\\n", "\u0000\ud800", "repeated ".repeat(20)][Math.floor(random() * 5)];
  const length = Math.floor(random() * 5);
  if (choice === 5) return Array.from({ length }, () => randomValue(random, depth + 1));
  const value = {};
  for (let index = 0; index < length; index += 1) {
    value[index % 2 ? `field_${index}` : `${index + 2}`] = randomValue(random, depth + 1);
  }
  return value;
}

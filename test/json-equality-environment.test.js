import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../src/json-value-equality.js", import.meta.url), "utf8")
  .replace(/^export /gm, "");

for (const [label, processValue] of [
  ["浏览器无 process", undefined],
  ["旧环境无 getBuiltinModule", {}],
  ["内建模块不可读取", { getBuiltinModule() { throw new Error("unavailable"); } }],
]) {
  test(`${label}时使用原 JSON 比较且不触碰 Proxy 探测`, () => {
    const result = runInNewContext(`${source}
      const stringify = JSON.stringify;
      let stringifyCalls = 0;
      let prototypeReads = 0;
      JSON.stringify = (...args) => { stringifyCalls++; return stringify(...args); };
      const proxy = new Proxy({ value: 1 }, {
        getPrototypeOf() { prototypeReads++; throw new Error("must not inspect prototype"); },
        get(target, key) { return key === "value" ? 2 : target[key]; },
      });
      ({ plain: sameJsonValue({ nested: ["中文", 1] }, { nested: ["中文", 1] }),
        proxy: sameJsonValue(proxy, { value: 2 }),
        stringifyCalls, prototypeReads });
    `, { process: processValue });
    assert.equal(result.plain, true);
    assert.equal(result.proxy, true);
    assert.equal(result.stringifyCalls, 4);
    assert.equal(result.prototypeReads, 0);
  });
}

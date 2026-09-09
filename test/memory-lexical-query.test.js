import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { prepareMemoryQuery } from "../src/memory/lexical-query.js";

test("礼貌用语过滤不把业务词请求拆成残缺片段", () => {
  const plan = prepareMemoryQuery("模型请求失败后如何重试？");
  assert.ok(plan.terms.some((term) => term.text === "请求"));
});

function texts(query) {
  return prepareMemoryQuery(query).terms.map(({ text }) => text);
}

test("Memory 词法查询保留原字面值与旧式输入兼容", () => {
  assert.equal(prepareMemoryQuery("  TypeScript 框架？  ").query, "TypeScript 框架？");
  for (const query of [undefined, null, false, 0, "", "  "]) {
    assert.deepEqual(prepareMemoryQuery(query), {
      query: "", terms: [], matchExpression: null, version: "memory-keywords-v1", termsTruncated: false,
    });
  }
  assert.equal(prepareMemoryQuery(42).query, "42");
  assert.equal(prepareMemoryQuery({ toString: () => "框架" }).query, "框架");
});

test("中文自然问句提取真实词项并降低项目和使用的权重", () => {
  const result = prepareMemoryQuery("我们项目使用什么语言和测试框架？");
  assert.ok(result.terms.some(({ text, weight }) => text === "测试" && weight === 1));
  assert.ok(result.terms.some(({ text }) => text === "语言"));
  assert.ok(result.terms.some(({ text }) => text === "框架"));
  assert.equal(result.terms.find(({ text }) => text === "项目").weight, 0.25);
  assert.equal(result.terms.find(({ text }) => text === "使用").weight, 0.25);
  const fact = "项目使用 TypeScript，测试使用 Vitest".toLowerCase();
  assert.ok(result.terms.some(({ text, weight }) => weight === 1 && fact.includes(text)));
  assert.ok(!texts("我们项目使用什么语言和测试框架？").some((term) => term.includes("和") || term.includes("什么")));
});

test("停用词和标点建立边界，不能制造原文中不存在的连续词项", () => {
  const query = "语言和测试，框架是否稳定？";
  for (const { text } of prepareMemoryQuery(query).terms) assert.ok(query.includes(text), text);
  assert.ok(!texts(query).includes("言测"));
  assert.ok(!texts(query).includes("架稳"));
  assert.deepEqual(texts("我们这个什么如何请问？"), []);
  assert.deepEqual(texts("what is the language for this project"), ["language", "project"]);
});

test("中英文混排、camelCase 和 snake_case 标识符按原字符拆分", () => {
  const result = texts("TypeScript项目 getHTTPResponse OPENAI_MODEL Vitest测试");
  for (const term of ["typescript", "type", "script", "项目", "gethttpresponse", "get", "http", "response", "openai_model", "openai", "model", "vitest", "测试"]) {
    assert.ok(result.includes(term), term);
  }
});

test("词项去重，权重为确定正数，重复查询不会扩大词项", () => {
  const short = prepareMemoryQuery("测试框架 Vitest 项目");
  const repeated = prepareMemoryQuery("测试框架 Vitest 项目 测试框架 VITEST 项目");
  assert.deepEqual(short.terms, repeated.terms);
  assert.ok(repeated.terms.every(({ weight }) => Number.isFinite(weight) && weight > 0));
  assert.equal(repeated.termsTruncated, false);
});

test("ASCII 折叠与 SQLite lower 一致，重音和其他 Unicode 大小写保留原字符", () => {
  const result = prepareMemoryQuery("CAFÉ café İSTANBUL Ελληνικά VITEST 测试");
  for (const term of ["cafÉ", "café", "İstanbul", "Ελληνικά", "vitest", "测试"]) {
    assert.ok(result.terms.some(({ text }) => text === term), term);
  }
  const db = new DatabaseSync(":memory:");
  try {
    for (const { text } of result.terms) {
      assert.equal(db.prepare("SELECT instr(lower(?), ?) > 0 AS matched").get(result.query, text).matched, 1);
    }
  } finally {
    db.close();
  }
});

test("短词与单字保留，三字符以下不进入 trigram MATCH", () => {
  const result = prepareMemoryQuery("中 语 go js C++ 测试");
  assert.deepEqual(result.terms.map(({ text }) => text), ["中", "语", "go", "js", "c", "测试"]);
  assert.equal(result.matchExpression, null);
  assert.equal(prepareMemoryQuery("测试框架").matchExpression, '"测试框" OR "试框架"');
});

test("FTS 操作符和引号只能作为字面词项，MATCH 可直接绑定执行", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE facts USING fts5(content, tokenize='trigram')");
    const insert = db.prepare("INSERT INTO facts(content) VALUES (?)");
    insert.run("literal AND OR NEAR quotation alpha");
    insert.run("unrelated content");
    for (const query of ['"AND" OR NEAR(alpha)', '"* : - + ( AND ) NEAR / \\ alpha', 'NEAR("alpha", 10)']) {
      const prepared = prepareMemoryQuery(query);
      assert.ok(prepared.matchExpression);
      const rows = db.prepare("SELECT rowid FROM facts WHERE facts MATCH ?").all(prepared.matchExpression);
      assert.deepEqual(rows.map(({ rowid }) => rowid), [1]);
    }
    assert.deepEqual(prepareMemoryQuery('" OR "').terms, [{ text: "or", weight: 1 }]);
    assert.equal(prepareMemoryQuery('" OR "').matchExpression, null);
    assert.deepEqual(texts('" * : - + ( ) / \\'), []);
  } finally {
    db.close();
  }
});

test("词项超过 24 时确定性分布采样保留尾部，并优先有效标识符", () => {
  const query = Array.from({ length: 100 }, (_, index) => `item${index}`).join(" ");
  const result = prepareMemoryQuery(query);
  assert.equal(result.terms.length, 24);
  assert.equal(result.termsTruncated, true);
  assert.ok(result.terms.some(({ text }) => text === "item0"));
  assert.ok(result.terms.some(({ text }) => text === "item99"));
  assert.deepEqual(result, prepareMemoryQuery(query));
  const mixed = prepareMemoryQuery(`${query} 语言测试框架检索配置缓存版本记录`);
  assert.equal(mixed.terms.length, 24);
  assert.ok(mixed.terms.some(({ text }) => text === "记录"));
  assert.ok(mixed.terms.filter(({ text }) => /^item\d+$/.test(text)).length >= 16);
});

test("长中文按整段分布采样，不只保留句首", () => {
  const query = "天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜";
  const result = prepareMemoryQuery(query);
  assert.equal(result.terms.length, 24);
  assert.equal(result.termsTruncated, true);
  assert.ok(result.terms.some(({ text }) => text === "天地"));
  assert.ok(result.terms.some(({ text }) => text === "为霜"));
  assert.ok(result.terms.every(({ text }) => query.includes(text)));
});

test("查询限制使用 trim 后 UTF-16 长度，明确拒绝超限且不静默截断", () => {
  const boundary = "a".repeat(4096);
  assert.equal(prepareMemoryQuery(` ${boundary} `).query, boundary);
  assert.throws(() => prepareMemoryQuery("a".repeat(4097)), /4096.*UTF-16/);
  assert.throws(() => prepareMemoryQuery("😀".repeat(2049)), /4096/);
});

test("Unicode 码点、组合字符、孤立代理和标点不会导致破损词项或病态回溯", () => {
  const result = prepareMemoryQuery("𠮷野家 café Cafe\u0301 한국어 日本語かな カタカナ 😀 \ud800");
  assert.ok(result.terms.some(({ text }) => text === "𠮷野"));
  assert.ok(result.terms.some(({ text }) => text === "𠮷野家"));
  assert.ok(result.terms.some(({ text }) => text === "cafe\u0301"));
  assert.ok(result.terms.every(({ text }) => !text.includes("\ud800") && !text.includes("😀")));
  assert.equal(prepareMemoryQuery("𠮷野").matchExpression, null);
  assert.equal(prepareMemoryQuery("𠮷野家").matchExpression, '"𠮷野家"');
  assert.equal(prepareMemoryQuery("_".repeat(4096)).terms.length, 0);
  assert.equal(prepareMemoryQuery("?".repeat(4096)).terms.length, 0);
  assert.ok(prepareMemoryQuery("汉".repeat(4096)).terms.length <= 24);
  assert.ok(prepareMemoryQuery("aA".repeat(2048)).terms.length <= 24);
});

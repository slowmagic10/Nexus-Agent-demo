import assert from "node:assert/strict";
import test from "node:test";
import {
  assertJournalImportBytes,
  assertJournalImportEnvelope,
  assertPortableArtifactBudget,
  JOURNAL_IMPORT_OPTIONS_RESERVE_BYTES,
  MAX_JOURNAL_IMPORT_BYTES,
  MAX_PORTABLE_ARTIFACT_BYTES,
} from "../src/persistence/archive-limits.js";

test("可恢复 Archive 的件数、内容预算和 HTTP 请求预算保持精确有界", () => {
  assert.doesNotThrow(() => assertPortableArtifactBudget({ count: 256, byteSize: MAX_PORTABLE_ARTIFACT_BYTES }));
  assert.throws(() => assertPortableArtifactBudget({ count: 257, byteSize: 0 }), /超过 256/);
  assert.throws(() => assertPortableArtifactBudget({ count: 1, byteSize: MAX_PORTABLE_ARTIFACT_BYTES + 1 }), /超过 64000000/);
  assert.doesNotThrow(() => assertJournalImportBytes(MAX_JOURNAL_IMPORT_BYTES));
  assert.throws(() => assertJournalImportBytes(MAX_JOURNAL_IMPORT_BYTES + 1), /10000000/);
  const portableLimit = MAX_JOURNAL_IMPORT_BYTES - JOURNAL_IMPORT_OPTIONS_RESERVE_BYTES;
  assert.doesNotThrow(() => assertJournalImportBytes(portableLimit, { exporting: true }));
  assert.throws(() => assertJournalImportBytes(portableLimit + 1, { exporting: true }), /预留 64000/);
});

test("HTTP envelope 使用 UTF-8 编码后的字节数，包括 JSON 转义与 archive 外壳", () => {
  const base = { content: "" };
  const overhead = Buffer.byteLength(JSON.stringify({ archive: base }));
  const archive = { content: "x".repeat(MAX_JOURNAL_IMPORT_BYTES - overhead) };
  assert.doesNotThrow(() => assertJournalImportEnvelope(archive));
  archive.content += "界";
  assert.throws(() => assertJournalImportEnvelope(archive), /10000000/);
  assert.throws(() => assertJournalImportEnvelope({ content: "\u0001".repeat(1_666_665) }), /10000000/);
});

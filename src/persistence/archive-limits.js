// A portable archive is a recoverable HTTP import payload, not a partial log export.
export const MAX_JOURNAL_IMPORT_BYTES = 10_000_000;
export const JOURNAL_IMPORT_OPTIONS_RESERVE_BYTES = 64_000;
export const MAX_PORTABLE_ARTIFACTS = 256;
export const MAX_PORTABLE_ARTIFACT_BYTES = 64_000_000;

export class ArchiveExportError extends Error {
  constructor(message, { statusCode = 422 } = {}) {
    super(message);
    this.name = "ArchiveExportError";
    this.statusCode = statusCode;
  }
}

export function assertPortableArtifactBudget({ count, byteSize }, { exporting = false } = {}) {
  const reject = (message) => { throw exporting ? new ArchiveExportError(message, { statusCode: 413 }) : new Error(message); };
  if (count > MAX_PORTABLE_ARTIFACTS) {
    reject(`portable journal Artifact 数量超过 ${MAX_PORTABLE_ARTIFACTS}；无法生成可恢复归档，请使用 SQLite 一致性备份保留完整项目数据库`);
  }
  if (byteSize > MAX_PORTABLE_ARTIFACT_BYTES) {
    reject(`portable journal Artifact 总量超过 ${MAX_PORTABLE_ARTIFACT_BYTES} 字节上限；无法生成可恢复归档，请使用 SQLite 一致性备份保留完整项目数据库`);
  }
}

export function assertJournalImportBytes(byteSize, { exporting = false } = {}) {
  const reserve = exporting ? JOURNAL_IMPORT_OPTIONS_RESERVE_BYTES : 0;
  if (byteSize + reserve > MAX_JOURNAL_IMPORT_BYTES) {
    const message = `portable journal 超过可恢复导出/导入的 ${MAX_JOURNAL_IMPORT_BYTES} 字节请求上限${exporting ? `（导出预留 ${reserve} 字节供目标 ID 与项目参数）` : ""}；请使用 SQLite 一致性备份保留完整项目数据库，不能删去归档中的 Artifact 或事件`;
    throw exporting ? new ArchiveExportError(message, { statusCode: 413 }) : new Error(message);
  }
}

export function assertJournalImportEnvelope(archive, options) {
  assertJournalImportBytes(Buffer.byteLength(JSON.stringify({ archive }), "utf8"), options);
}

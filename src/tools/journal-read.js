import { serializeToolHistory } from "../core/tool-history.js";

export function toolHistoryDefinition() {
  return {
    name: "read_tool_history",
    description: "只读回查当前 Session 的脱敏工具审计记录，不执行历史工具。先用 call_id 发现 occurrence，再用 source_cursor（TOOL_REQUESTED durable cursor，非展示 seq）分页读取原参数及结果。Artifact 内容用 read_artifact。后续页携带 snapshot_cursor；字符后续页还需 expected_sha256。JSON页按Unicode字符计数，响应预算可能缩短实际页长。request/result正文合计超过4MB时只返回record_too_large及可用Artifact引用；私密记忆/凭据工具正文及本工具自身输出不开放。",
    approval: "never",
    effects: ["read"],
    idempotency: "safe",
    capability: { risk: "R0", readOnly: true, resources: [{ kind: "session", access: "read" }] },
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        call_id: { type: "string", minLength: 1, maxLength: 1_000, description: "按工具调用ID发现所有 occurrence；也可与 source_cursor 核对" },
        source_cursor: { type: "integer", minimum: 1, description: "精读某次 TOOL_REQUESTED 的 durable cursor" },
        after_cursor: { type: "integer", minimum: 0, description: "发现下一页的 nextAfterCursor，默认0" },
        snapshot_cursor: { type: "integer", minimum: 1, description: "首次响应 snapshotCursor，后续分页必填" },
        page_size: { type: "integer", minimum: 1, maximum: 20, description: "发现条数，默认10，最多20" },
        offset: { type: "integer", minimum: 0, description: "JSON字符页起点，默认0；下一页使用nextOffset" },
        limit: { type: "integer", minimum: 1, maximum: 8_000, description: "字符页长度，默认4000，最多8000，受最终响应预算限制" },
        expected_sha256: { type: "string", pattern: "^[a-f0-9]{64}$", description: "首次字符页的sha256；offset大于0时必填" },
      },
    },
    execute: async (options, context) => {
      context.signal?.throwIfAborted?.();
      const result = typeof context.queryToolHistory === "function"
        ? await context.queryToolHistory(options)
        : { available: false, reason: "durable_journal_unavailable" };
      return serializeToolHistory(result);
    },
  };
}

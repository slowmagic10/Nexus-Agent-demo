import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { redactSensitiveText } from "../security/redact.js";

const MAX_CRITERIA = 20;
const MAX_PATHS = 50;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

// Acceptance declarations are append-only within an Objective. Ordinary Plan
// status updates cannot remove a check, change its command or manufacture proof.
export function mergeAcceptance(previous = [], supplied) {
  if (supplied === undefined) return structuredClone(previous);
  if (!Array.isArray(supplied) || supplied.length > MAX_CRITERIA) throw new Error("验收项最多 20 项");
  const incoming = supplied.map(normalizeCriterion);
  if (new Set(incoming.map((item) => item.id)).size !== incoming.length) throw new Error("验收项 id 不能重复");
  if (new Set(incoming.flatMap((item) => item.paths)).size > MAX_PATHS) throw new Error("验收输入最多 50 个不同文件");
  for (const existing of previous) {
    const declared = incoming.find((item) => item.id === existing.id);
    if (!declared || !isDeepStrictEqual(specification(existing), declared)) {
      throw new Error(`同一 Objective 中不能移除或修改已有验收项：${existing.id}`);
    }
  }
  return incoming.map((item) => structuredClone(previous.find((old) => old.id === item.id)
    || { ...item, status: "pending", evidence: null }));
}

export function verificationIssues(state) {
  if (state.plan?.objectiveId !== state.objective?.id) return [];
  return state.plan.acceptance?.some((item) => !hasVerificationEvidence(state, item)) ? ["verification_incomplete"] : [];
}

export function recordVerificationToolResult(state, action, at) {
  const record = action.verification;
  if (!record || record.objectiveId !== state.objective?.id || state.plan?.objectiveId !== state.objective.id) return null;
  const criterion = state.plan.acceptance?.find((item) => item.id === record.id);
  if (!criterion || action.call.name !== "run_shell" || action.call.arguments?.verification_id !== criterion.id
    || action.call.arguments?.command !== criterion.command || record.command !== criterion.command
    || !Number.isSafeInteger(action.sourceCursor) || action.sourceCursor < 1) {
    throw new Error("验收结果没有绑定当前预声明命令与真实工具 occurrence");
  }
  const before = normalizeInputs(record.before, criterion.paths);
  const after = normalizeInputs(record.after, criterion.paths);
  const stable = before && after && isDeepStrictEqual(before, after);
  const passed = action.ok === true && action.status === "completed" && stable;
  criterion.status = passed ? "passed" : action.ok === true ? "stale" : "failed";
  criterion.reason = passed ? null : record.reason || (stable ? "command_failed" : "inputs_changed_or_unavailable");
  criterion.evidence = {
    sourceCursor: action.sourceCursor,
    toolCallId: action.call.id,
    command: criterion.command,
    inputs: after || [],
    verifiedAt: at,
  };
  return { id: criterion.id, objectiveId: state.objective.id, status: criterion.status, inputsHash: digestInputs(criterion.evidence.inputs), reason: criterion.reason };
}

export function invalidateVerification(state, action) {
  if (state.plan?.objectiveId !== action.objectiveId) return false;
  const criterion = state.plan.acceptance?.find((item) => item.id === action.id);
  if (!criterion || criterion.status !== "passed" || criterion.evidence?.sourceCursor !== action.sourceCursor) return false;
  criterion.status = "stale";
  criterion.reason = action.reason || "inputs_changed_or_unavailable";
  return true;
}

export async function executeVerification({ id, command, context, workspace, execute }) {
  const state = context.state;
  const criterion = state.plan?.objectiveId === state.objective?.id
    ? state.plan.acceptance?.find((item) => item.id === id) : null;
  if (!criterion) throw new Error(`未声明验收项：${id}`);
  if (command !== criterion.command) throw new Error(`验收命令必须与 ${id} 的预声明 command 完全一致`);
  if (typeof context.recordVerification !== "function" || typeof context.authorizeRead !== "function") {
    throw new Error("当前 Tool Host 不支持可信验收记录");
  }
  const record = { id, command, objectiveId: state.objective.id, before: null, after: null, reason: null };
  // A non-cooperative adapter may outlive the Host watchdog. Register the
  // attempt now so a timed-out TOOL_RESULT invalidates earlier successful proof.
  context.recordVerification(record);
  try {
    record.before = await snapshotVerificationInputs({ workspace, paths: criterion.paths, authorizeRead: context.authorizeRead, signal: context.signal });
    const output = await execute();
    record.after = await snapshotVerificationInputs({ workspace, paths: criterion.paths, authorizeRead: context.authorizeRead, signal: context.signal });
    if (!isDeepStrictEqual(record.before, record.after)) record.reason = "inputs_changed_during_command";
    return output;
  } catch (error) {
    record.reason = context.signal?.aborted ? "cancelled" : "command_or_input_failed";
    throw error;
  } finally {
    context.recordVerification(record);
  }
}

export async function refreshVerification({ session, workspace, authorizeRead, signal }) {
  const state = session.state;
  if (state.plan?.objectiveId !== state.objective?.id) return;
  for (const criterion of state.plan?.acceptance || []) {
    signal?.throwIfAborted();
    if (criterion.status !== "passed") continue;
    let reason = null;
    if (!hasVerificationEvidence(state, criterion)) reason = "missing_tool_result";
    else if (typeof authorizeRead !== "function") reason = "verification_reader_unavailable";
    else {
      try {
        const current = await snapshotVerificationInputs({ workspace, paths: criterion.paths, authorizeRead, signal });
        if (!isDeepStrictEqual(current, criterion.evidence.inputs)) reason = "inputs_changed";
      } catch {
        signal?.throwIfAborted();
        reason = "inputs_changed_or_unavailable";
      }
    }
    if (reason) await session.dispatch({
      type: "VERIFICATION_INVALIDATED", objectiveId: state.objective.id,
      id: criterion.id, sourceCursor: criterion.evidence?.sourceCursor, reason,
    });
  }
}

export async function snapshotVerificationInputs({ workspace, paths, authorizeRead, signal }) {
  if (typeof authorizeRead !== "function") throw new Error("验收文件读取必须经过当前 Host 授权");
  const requestedPaths = normalizePaths(paths);
  const root = await fs.realpath(path.resolve(workspace));
  const records = [];
  let bytes = 0;
  for (const relative of requestedPaths) {
    signal?.throwIfAborted();
    const authorize = async () => {
      signal?.throwIfAborted();
      if (await authorizeRead(relative) !== true) throw new Error("验收输入读取被拒绝");
    };
    await authorize();
    const file = path.join(root, relative);
    const ancestors = await inspectAncestors(root, relative);
    const before = await fs.lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("验收输入必须是普通文件，不允许符号链接");
    if (before.size > BigInt(MAX_FILE_BYTES) || bytes + Number(before.size) > MAX_TOTAL_BYTES) throw new Error("验收输入超过读取上限");
    let handle;
    try {
      handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      const opened = await handle.stat({ bigint: true });
      await assertStableFile(root, relative, ancestors, opened, before);
      await authorize();
      const digest = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let offset = 0;
      while (offset < Number(opened.size)) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(opened.size) - offset), offset);
        if (!bytesRead) break;
        digest.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (offset !== Number(opened.size)) throw new Error("验收输入读取不完整");
      await assertStableFile(root, relative, ancestors, after, opened);
      await authorize();
      records.push({ path: relative, sha256: digest.digest("hex"), byteSize: offset, version: fileVersion(after) });
      bytes += offset;
    } finally {
      await handle?.close();
    }
  }
  return records;
}

function hasVerificationEvidence(state, criterion) {
  if (criterion.status !== "passed" || !criterion.evidence
    || criterion.evidence.command !== criterion.command || !normalizeInputs(criterion.evidence.inputs, criterion.paths)) return false;
  return state.events.some((event) => event.type === "tool.completed" && event.tool === "run_shell"
    && event.callId === criterion.evidence.toolCallId && event.sourceCursor === criterion.evidence.sourceCursor
    && event.ok === true && event.status === "completed" && event.verification?.id === criterion.id
    && event.verification.objectiveId === state.objective.id
    && event.verification.status === "passed" && event.verification.inputsHash === digestInputs(criterion.evidence.inputs));
}

function normalizeCriterion(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)
    || Object.keys(item).some((key) => !["id", "description", "command", "paths"].includes(key))) throw new Error("验收项只能声明 id、description、command、paths");
  const id = requiredText(item.id, "id", 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error("验收 id 只能包含字母、数字、下划线和连字符");
  const command = requiredText(item.command, "command", 8_000);
  if (redactSensitiveText(command) !== command) throw new Error("验收命令不能包含明文凭据");
  return { id, description: redactSensitiveText(requiredText(item.description, "description", 500)), command, paths: normalizePaths(item.paths) };
}

function specification(item) {
  return { id: item.id, description: item.description, command: item.command, paths: item.paths };
}

function normalizePaths(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_PATHS) throw new Error("验收输入需要 1 到 50 个明确的相对文件路径");
  const paths = values.map((value) => {
    const relative = requiredText(value, "path", 512);
    if (relative.includes("\\") || path.isAbsolute(relative) || relative.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("验收路径必须是工作区内的规范相对文件路径");
    return relative;
  });
  if (new Set(paths).size !== paths.length) throw new Error("验收输入文件不能重复");
  return paths.sort();
}

function requiredText(value, label, maximum) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) throw new Error(`验收 ${label} 必须是 1 到 ${maximum} 字符的非空文本`);
  return value.trim();
}

function normalizeInputs(inputs, paths) {
  if (!Array.isArray(inputs) || inputs.length !== paths.length) return null;
  if (inputs.some((item, index) => !item || item.path !== paths[index] || !/^[a-f0-9]{64}$/.test(item.sha256)
    || !Number.isSafeInteger(item.byteSize) || item.byteSize < 0 || item.byteSize > MAX_FILE_BYTES
    || typeof item.version !== "string" || item.version.length > 200)) return null;
  return inputs.map(({ path, sha256, byteSize, version }) => ({ path, sha256, byteSize, version }));
}

function digestInputs(inputs) {
  return createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
}

async function inspectAncestors(root, relative) {
  const parents = [root];
  for (const part of relative.split("/").slice(0, -1)) parents.push(path.join(parents.at(-1), part));
  const snapshots = [];
  for (const parent of parents) {
    const stat = await fs.lstat(parent, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("验收路径不能包含符号链接目录");
    snapshots.push({ path: parent, dev: stat.dev, ino: stat.ino });
  }
  return snapshots;
}

async function assertStableFile(root, relative, ancestors, current, previous) {
  if (!current.isFile() || fileVersion(current) !== fileVersion(previous) || current.size !== previous.size) throw new Error("验收文件在读取期间变化");
  if (!isDeepStrictEqual(await inspectAncestors(root, relative), ancestors)) throw new Error("验收目录在读取期间变化");
  const linked = await fs.lstat(path.join(root, relative), { bigint: true });
  if (!linked.isFile() || linked.isSymbolicLink() || fileVersion(linked) !== fileVersion(current)) throw new Error("验收路径在读取期间变化");
}

function fileVersion(stat) {
  return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

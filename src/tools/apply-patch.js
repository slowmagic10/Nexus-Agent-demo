import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_OPERATIONS = 50;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const OPERATION_FIELDS = Object.freeze({
  add: new Set(["operation", "path", "content"]),
  update: new Set(["operation", "path", "old_text", "new_text", "expected_replacements"]),
  delete: new Set(["operation", "path", "expected_sha256"]),
});

// Preflights every operation before the first write and rolls back committed files on failure.
export async function applyWorkspacePatch({ workspace, operations, accessPolicy, signal, fileSystem = fs } = {}) {
  if (typeof workspace !== "string" || !workspace) throw new Error("apply_patch 需要 workspace");
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > MAX_OPERATIONS) {
    throw new Error(`apply_patch operations 必须包含 1 到 ${MAX_OPERATIONS} 项`);
  }
  if (!accessPolicy || typeof accessPolicy.assertPath !== "function") {
    throw new Error("apply_patch 需要 Access Policy");
  }
  const root = await fileSystem.realpath(path.resolve(workspace));
  const plans = [];
  const targets = new Map();

  for (let index = 0; index < operations.length; index += 1) {
    signal?.throwIfAborted?.();
    const operation = normalizeOperation(operations[index], index);
    const target = await resolveWorkspacePath(root, operation.path, fileSystem);
    const relativePath = path.relative(root, target) || ".";
    accessPolicy.assertPath(relativePath, "write");
    const previousIndex = targets.get(target);
    if (previousIndex !== undefined) {
      const previous = plans[previousIndex];
      if (previous.requestedPath !== operation.path || previous.operation !== "update" || operation.operation !== "update") {
        throw new Error(`apply_patch 包含有歧义的重复目标（同一真实文件）：${operation.path}`);
      }
      plans[previousIndex] = {
        ...previous,
        after: applyTextUpdate(operation, previous.after),
        operationCount: previous.operationCount + 1,
      };
      continue;
    }
    const plan = await preflightOperation(operation, target, relativePath, fileSystem);
    targets.set(target, plans.length);
    plans.push(plan);
  }

  const totalBytes = plans.reduce((total, plan) => (
    total + (plan.before?.byteLength || 0) + (plan.after?.byteLength || 0)
  ), 0);
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error("apply_patch 预检内容总量超过 32 MiB；文件未修改");

  signal?.throwIfAborted?.();
  for (const plan of plans) await assertPlanStillCurrent(plan, fileSystem);

  const attempted = [];
  try {
    for (const plan of plans) {
      signal?.throwIfAborted?.();
      // A write may mutate the file before rejecting, so include the current plan in rollback first.
      attempted.push(plan);
      if (plan.operation === "delete") {
        await fileSystem.unlink(plan.target);
      } else {
        await fileSystem.mkdir(path.dirname(plan.target), { recursive: true });
        await fileSystem.writeFile(plan.target, plan.after);
        if (plan.mode !== null) await fileSystem.chmod(plan.target, plan.mode);
      }
    }
  } catch (error) {
    const rollbackErrors = await rollback(attempted, fileSystem);
    if (rollbackErrors.length) {
      throw new AggregateError([error, ...rollbackErrors], "apply_patch 提交失败且未能完整回滚；文件状态需要人工检查");
    }
    throw new Error(`apply_patch 提交失败，已回滚所有已提交文件：${error?.message || "未知错误"}`);
  }

  return {
    added: plans.filter((plan) => plan.operation === "add").length,
    updated: plans.filter((plan) => plan.operation === "update").length,
    deleted: plans.filter((plan) => plan.operation === "delete").length,
    paths: plans.map((plan) => plan.relativePath),
    operations: plans.reduce((total, plan) => total + plan.operationCount, 0),
  };
}

function normalizeOperation(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`apply_patch operations[${index}] 必须是对象`);
  }
  const operation = value.operation;
  const allowed = OPERATION_FIELDS[operation];
  if (!allowed) throw new Error(`apply_patch operations[${index}].operation 无效`);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`apply_patch operations[${index}] 包含未知字段 ${unknown}`);
  if (typeof value.path !== "string" || !value.path.trim()) {
    throw new Error(`apply_patch operations[${index}].path 必须是非空字符串`);
  }
  if (operation === "add" && typeof value.content !== "string") {
    throw new Error(`apply_patch operations[${index}].content 必须是字符串`);
  }
  if (operation === "update") {
    if (typeof value.old_text !== "string" || !value.old_text) {
      throw new Error(`apply_patch operations[${index}].old_text 不能为空`);
    }
    if (typeof value.new_text !== "string") {
      throw new Error(`apply_patch operations[${index}].new_text 必须是字符串`);
    }
    if (value.old_text === value.new_text) throw new Error(`apply_patch operations[${index}] 没有产生变化`);
    const expected = value.expected_replacements ?? 1;
    if (!Number.isSafeInteger(expected) || expected < 1 || expected > 1000) {
      throw new Error(`apply_patch operations[${index}].expected_replacements 必须是 1 到 1000 的整数`);
    }
    return { ...value, expected_replacements: expected, path: value.path.trim() };
  }
  if (operation === "delete" && value.expected_sha256 !== undefined) {
    if (typeof value.expected_sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(value.expected_sha256)) {
      throw new Error(`apply_patch operations[${index}].expected_sha256 必须是 SHA-256`);
    }
  }
  return { ...value, path: value.path.trim() };
}

async function preflightOperation(operation, target, relativePath, fileSystem) {
  const current = await readCurrentFile(target, fileSystem);
  if (operation.operation === "add") {
    if (current) throw new Error(`apply_patch add 目标已存在：${operation.path}`);
    const after = Buffer.from(operation.content, "utf8");
    assertResultSize(after, operation.path);
    return {
      ...operation,
      requestedPath: operation.path,
      target,
      relativePath,
      before: null,
      after,
      mode: null,
      beforeHash: null,
      operationCount: 1,
    };
  }
  if (!current) throw new Error(`apply_patch ${operation.operation} 目标不存在：${operation.path}`);
  if (!current.stat.isFile()) throw new Error(`apply_patch 只能处理普通文件：${operation.path}`);
  if (current.bytes.byteLength > MAX_SOURCE_BYTES) throw new Error(`apply_patch 文件超过 4 MiB：${operation.path}`);
  const beforeHash = sha256(current.bytes);
  if (operation.operation === "delete") {
    if (operation.expected_sha256 && operation.expected_sha256.toLowerCase() !== beforeHash) {
      throw new Error(`apply_patch delete 的 expected_sha256 不匹配：${operation.path}`);
    }
    return {
      ...operation,
      requestedPath: operation.path,
      target,
      relativePath,
      before: current.bytes,
      after: null,
      mode: current.stat.mode & 0o7777,
      beforeHash,
      operationCount: 1,
    };
  }

  return {
    ...operation,
    requestedPath: operation.path,
    target,
    relativePath,
    before: current.bytes,
    after: applyTextUpdate(operation, current.bytes),
    mode: current.stat.mode & 0o7777,
    beforeHash,
    operationCount: 1,
  };
}

function applyTextUpdate(operation, currentBytes) {
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(currentBytes);
  } catch {
    throw new Error(`apply_patch update 只支持合法 UTF-8 文本：${operation.path}`);
  }
  const actual = countOccurrences(source, operation.old_text);
  if (actual !== operation.expected_replacements) {
    throw new Error(`apply_patch ${operation.path} 预期匹配 ${operation.expected_replacements} 处，实际匹配 ${actual} 处；所有文件均未修改`);
  }
  const after = Buffer.from(source.split(operation.old_text).join(operation.new_text), "utf8");
  assertResultSize(after, operation.path);
  return after;
}

async function readCurrentFile(target, fileSystem) {
  try {
    const stat = await fileSystem.stat(target);
    const bytes = stat.isFile() ? await fileSystem.readFile(target) : Buffer.alloc(0);
    return { stat, bytes };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertPlanStillCurrent(plan, fileSystem) {
  const current = await readCurrentFile(plan.target, fileSystem);
  if (plan.before === null) {
    if (current) throw new Error(`apply_patch 提交前目标已被创建：${plan.relativePath}`);
    return;
  }
  if (!current?.stat.isFile() || sha256(current.bytes) !== plan.beforeHash) {
    throw new Error(`apply_patch 提交前文件已变化：${plan.relativePath}`);
  }
}

async function rollback(committed, fileSystem) {
  const errors = [];
  for (const plan of [...committed].reverse()) {
    try {
      if (plan.before === null) {
        await fileSystem.rm(plan.target, { force: true });
      } else {
        await fileSystem.mkdir(path.dirname(plan.target), { recursive: true });
        await fileSystem.writeFile(plan.target, plan.before);
        if (plan.mode !== null) await fileSystem.chmod(plan.target, plan.mode);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function resolveWorkspacePath(root, requested, fileSystem) {
  const target = path.resolve(root, requested || ".");
  if (!within(root, target)) throw new Error("apply_patch 路径越过了工作区边界");
  let existing = target;
  while (true) {
    try {
      await fileSystem.lstat(existing);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  const realExisting = await fileSystem.realpath(existing);
  if (!within(root, realExisting)) throw new Error("apply_patch 符号链接越过了工作区边界");
  const resolved = path.join(realExisting, path.relative(existing, target));
  if (!within(root, resolved)) throw new Error("apply_patch 路径越过了工作区边界");
  return resolved;
}

function within(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function countOccurrences(source, target) {
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(target, offset)) !== -1) {
    count += 1;
    offset += target.length;
  }
  return count;
}

function assertResultSize(value, requested) {
  if (value.byteLength > MAX_RESULT_BYTES) throw new Error(`apply_patch 结果超过 8 MiB：${requested}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

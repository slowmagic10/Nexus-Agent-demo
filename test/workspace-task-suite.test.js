import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runWorkspaceTaskSuite } from "../src/evaluation/workspace-task-suite.js";
import { ProviderHttpError } from "../src/providers/errors.js";

const task = (overrides = {}) => ({ id: "write-report", prompt: "Write a result file", files: [],
  checks: [{ id: "result", type: "file_equals", path: "result.txt", expected: "done" }], ...overrides });
const suite = (value = task()) => ({ id: "local-eval", tasks: [value] });
const response = (text = "完成", toolCalls = []) => ({ text, toolCalls, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
const writer = () => {
  let count = 0;
  return { name: "fixture-provider", complete: async () => ++count === 1
    ? response("", [{ id: "write", name: "write_file", arguments: { path: "result.txt", content: "done" } }])
    : response() };
};

test("模型声称完成但未写文件被标记 falseCompletion，报告不泄露提示或输出", async () => {
  const report = await runWorkspaceTaskSuite(suite(task({ prompt: "private prompt secret 123456" })), {
    providerFactory: () => ({ name: "fixture-provider", complete: async () => response("private answer secret 123456") }),
  });
  assert.equal(report.passed, false);
  assert.equal(report.results[0].phase, "completed");
  assert.equal(report.results[0].falseCompletion, true);
  assert.equal(report.results[0].checks[0].code, "file_missing");
  assert.equal(report.score.falseCompletions, 1);
  assert.doesNotMatch(JSON.stringify(report), /private prompt|private answer|123456|result\.txt/);
});

test("真实 Registry/ToolHost 写文件后按磁盘验收，并记录实际资源指标", async () => {
  const workspaces = [];
  const report = await runWorkspaceTaskSuite(suite(), { providerFactory: ({ workspace }) => {
    workspaces.push(workspace);
    const provider = writer();
    const complete = provider.complete;
    provider.complete = async (request) => {
      const names = request.tools.map((tool) => tool.function.name);
      assert.ok(names.includes("write_file"));
      assert.ok(names.includes("update_plan"));
      assert.equal(names.includes("run_shell"), false);
      assert.equal(names.includes("load_skill"), false);
      return complete(request);
    };
    return provider;
  } });
  assert.equal(report.passed, true);
  assert.equal(report.results[0].metrics.turns, 1);
  assert.equal(report.results[0].metrics.toolCalls, 1);
  assert.equal(report.results[0].metrics.modelCalls, 2);
  assert.equal(report.results[0].provider, "fixture-provider");
  assert.equal(report.results[0].execution.adapter, "file-only");
  assert.match(report.results[0].checks[0].actualHash, /^sha256:/);
  for (const workspace of workspaces) await assert.rejects(fs.access(workspace));
});

test("每次 trial 使用独立 Provider 与全新种子，最终全部清理", async () => {
  const roots = [];
  const report = await runWorkspaceTaskSuite(suite(task({ trials: 3,
    files: [{ path: "seed/note.txt", content: "seed secret" }] })), {
    providerFactory: async ({ workspace, trial }) => {
      roots.push(workspace);
      assert.equal(trial, roots.length);
      assert.equal(await fs.readFile(path.join(workspace, "seed/note.txt"), "utf8"), "seed secret");
      await assert.rejects(fs.access(path.join(workspace, "result.txt")));
      return writer();
    },
  });
  assert.equal(new Set(roots).size, 3);
  assert.equal(report.score.passed, 3);
  assert.equal(new Set(report.results.map((result) => result.taskHash)).size, 1);
  assert.doesNotMatch(JSON.stringify(report), /seed secret/);
  for (const workspace of roots) await assert.rejects(fs.access(workspace));
});

test("file_contains 与 json_equals 使用实际内容，JSON 对象键顺序无关", async () => {
  const report = await runWorkspaceTaskSuite(suite(task({
    files: [{ path: "data.json", content: '{"b":2,"a":1}' }],
    checks: [
      { id: "json", type: "json_equals", path: "data.json", expected: { a: 1, b: 2 } },
      { id: "contains", type: "file_contains", path: "data.json", expected: '"b":2' },
    ],
  })), { providerFactory: () => ({ name: "fixture", complete: async () => response() }) });
  assert.equal(report.passed, true);
  assert.ok(report.results[0].checks.every((check) => check.passed));
});

test("未知验收、无验收、越界/歧义路径与非法种子先于 Provider 创建拒绝", async () => {
  let calls = 0;
  const options = { providerFactory: () => { calls += 1; return writer(); } };
  for (const requested of ["../escape", "/tmp/escape", "a/../x", "a//x", "a\\x", "a\u0000x", ".", ".nexus/nexus.db"]) {
    await assert.rejects(runWorkspaceTaskSuite(suite(task({ files: [{ path: requested, content: "x" }] })), options), /路径/);
    await assert.rejects(runWorkspaceTaskSuite(suite(task({ checks: [{ id: "bad", type: "file_equals", path: requested, expected: "x" }] })), options), /路径/);
  }
  for (const invalid of [
    { checks: [] },
    { checks: [{ id: "bad", type: "run_shell", path: "a", expected: "x" }] },
    { checks: [{ id: "bad", type: "file_equals", path: "a", expected: {} }] },
    { files: [{ path: "a", content: "x", symlink: "../escape" }] },
    { files: [{ path: "a", content: "x" }, { path: "a/b", content: "x" }] },
    { files: [{ path: "a", content: "x" }, { path: "a-", content: "x" }, { path: "a/b", content: "x" }] },
    { trials: 0 }, { trials: 1000 }, { maxSteps: Infinity },
  ]) await assert.rejects(runWorkspaceTaskSuite(suite(task(invalid)), options));
  assert.equal(calls, 0);
});

test("最终产物符号链接和超量输出不能通过验收或泄露正文", async (t) => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-eval-owned-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "private.txt"), "private outside content");
  for (const mode of ["symlink", "directory-symlink", "large", "json"]) {
    const check = { id: "result", type: mode === "json" ? "json_equals" : "file_contains", path: mode === "directory-symlink" ? "nested/private.txt" : "result.txt", expected: mode === "json" ? {} : "private" };
    const report = await runWorkspaceTaskSuite(suite(task({ checks: [check] })), { providerFactory: async ({ workspace }) => {
      if (mode === "symlink") await fs.symlink(path.join(outside, "private.txt"), path.join(workspace, "result.txt"));
      else if (mode === "directory-symlink") await fs.symlink(outside, path.join(workspace, "nested"));
      else await fs.writeFile(path.join(workspace, "result.txt"), mode === "large" ? "x".repeat(1_000_001) : "private invalid json");
      return { name: "fixture", complete: async () => response() };
    } });
    assert.equal(report.passed, false);
    assert.equal(report.results[0].checks[0].code, mode === "large" ? "file_too_large" : mode === "json" ? "invalid_json" : "unsafe_path");
    assert.doesNotMatch(JSON.stringify(report), /private outside content|private invalid json/);
  }
});

test("Provider 初始化错误保留安全失败元数据且清理目录", async () => {
  let workspace;
  const report = await runWorkspaceTaskSuite(suite(), { providerFactory: (context) => {
    workspace = context.workspace;
    throw new Error(`private key sk-this-is-secret ${workspace}`);
  } });
  assert.equal(report.passed, false);
  assert.equal(report.results[0].errorCode, "provider_initialization_failed");
  assert.doesNotMatch(JSON.stringify(report), /private key|sk-this|nexus-task-trial/);
  await assert.rejects(fs.access(workspace));
});

test("取消当前 trial 后不再启动剩余 trial，并清理临时工作区", async () => {
  const abort = new AbortController();
  const roots = [];
  const report = await runWorkspaceTaskSuite(suite(task({ trials: 3 })), { signal: abort.signal,
    providerFactory: ({ workspace }) => {
      roots.push(workspace);
      return { name: "fixture", complete: async ({ signal }) => {
        queueMicrotask(() => abort.abort());
        return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      } };
    },
  });
  assert.equal(report.cancelled, true);
  assert.equal(report.results[0].phase, "cancelled");
  assert.equal(roots.length, 1);
  assert.equal(report.score.notRun, 2);
  for (const workspace of roots) await assert.rejects(fs.access(workspace));
  const before = await runWorkspaceTaskSuite(suite(), { signal: AbortSignal.abort(), providerFactory: () => assert.fail("must not start") });
  assert.equal(before.results.length, 0);
});

test("Shell 评测必须显式提供 Execution Factory", async () => {
  await assert.rejects(runWorkspaceTaskSuite(suite(), { providerFactory: writer, allowShell: true }), /executionFactory/);
});

test("显式 Shell 使用每个 trial 绑定的 Execution Adapter，原有真实工具链保持可用", async () => {
  let executions = 0;
  const report = await runWorkspaceTaskSuite(suite(task({ trials: 2 })), {
    allowShell: true,
    executionFactory: ({ workspace }) => ({ id: "fixture-sandbox", execute: async (spec) => {
      executions += 1;
      assert.equal(spec.cwd, ".");
      await fs.writeFile(path.join(workspace, "result.txt"), "done");
      return { exitCode: 0, stdout: "done", stderr: "" };
    } }),
    providerFactory: () => {
      let count = 0;
      return { name: "fixture", complete: async ({ tools }) => {
        assert.ok(tools.some((tool) => tool.function.name === "run_shell"));
        return ++count === 1 ? response("", [{ id: "test-command", name: "run_shell", arguments: { command: "printf done > result.txt" } }]) : response();
      } };
    },
  });
  assert.equal(executions, 2);
  assert.equal(report.passed, true);
  assert.ok(report.results.every((result) => result.execution.adapter === "fixture-sandbox"));
});

test("预算耗尽即使文件检查通过也不能报告任务成功", async () => {
  const report = await runWorkspaceTaskSuite(suite(task({ maxSteps: 1 })), { providerFactory: writer });
  assert.equal(report.results[0].checks[0].passed, true);
  assert.equal(report.results[0].phase, "failed");
  assert.equal(report.results[0].passed, false);
  assert.equal(report.results[0].falseCompletion, false);
  assert.equal(report.results[0].budget.maxSteps, 1);
});

test("真实工具任务报告追加只读轮次诊断，原结果哈希继续仅覆盖产物验收", async () => {
  const report = await runWorkspaceTaskSuite(suite(), { providerFactory: writer });
  const result = report.results[0];
  assert.equal(result.diagnostics.version, "turn-diagnostics-v1");
  assert.equal(result.diagnostics.reliability.observedUserMessages, 1);
  assert.equal(result.diagnostics.turns[0].origin, "new_objective");
  assert.equal(result.diagnostics.turns[0].outcome, "completed");
  assert.equal(result.diagnostics.reliability.usage.reportedComplete, 2);
  const oldPayload = { phase: result.phase, passed: result.passed, errorCode: result.errorCode, checks: result.checks };
  assert.equal(result.resultHash, `sha256:${createHash("sha256").update(JSON.stringify(oldPayload)).digest("hex")}`);
});

test("真实运行的模型自动重试耗尽报告保留安全诊断，不泄露错误正文", async () => {
  let calls = 0;
  const report = await runWorkspaceTaskSuite(suite(task({ prompt: "private prompt do not print" })), {
    providerFactory: () => ({ name: "fixture", complete: async () => {
      calls += 1;
      throw new ProviderHttpError("private endpoint token and error", { status: 503 });
    } }),
  });
  assert.equal(calls, 3);
  const result = report.results[0];
  assert.equal(result.phase, "failed");
  assert.equal(result.diagnostics.reliability.model.requestFailed, 3);
  assert.equal(result.diagnostics.reliability.model.retryRequested, 2);
  assert.equal(result.diagnostics.reliability.model.retryExhausted, 1);
  assert.equal(result.diagnostics.turns[0].stopReason, "model_retry_exhausted");
  assert.equal(result.diagnostics.turns[0].outcome, "paused");
  assert.equal(result.diagnostics.reliability.terminalEvents.failed, 1);
  assert.equal(result.diagnostics.reliability.observedUserContinuations, 0);
  assert.equal(result.diagnostics.reliability.unnecessaryContinuationRate, null);
  assert.doesNotMatch(JSON.stringify(report), /private prompt|private endpoint|token and error/);
});

test("报告保留路径型真实模型身份，URL/凭据名仅保留摘要", async () => {
  for (const name of ["openai-compatible//models/Qwen3.8-27B-NVFP4", "https://user:password@model.invalid/v1", "provider/sk-1234567890abcdefghijkl"]) {
    const report = await runWorkspaceTaskSuite(suite(), { providerFactory: () => ({ ...writer(), name }) });
    const result = report.results[0];
    assert.equal(result.providerIdentityHash, `sha256:${createHash("sha256").update(name).digest("hex")}`);
    assert.equal(result.provider, name.startsWith("openai-compatible") ? name : "custom-provider");
    if (!name.startsWith("openai-compatible")) assert.equal(JSON.stringify(report).includes(name), false);
  }
});

test("异步 Factory 永不返回时取消仍能结束；迟到初始化结果不会启动任务", async () => {
  for (const stage of ["provider", "execution"]) {
    const abort = new AbortController();
    const started = Promise.withResolvers();
    const pending = Promise.withResolvers();
    let workspace;
    let modelCalls = 0;
    let executions = 0;
    const waitingFactory = (context) => {
      workspace = context.workspace;
      started.resolve();
      assert.equal(context.signal, abort.signal);
      return pending.promise;
    };
    const provider = { name: "fixture", complete: async () => { modelCalls += 1; return response(); } };
    const execution = { id: "fixture", execute: async () => { executions += 1; return { exitCode: 0, stdout: "", stderr: "" }; } };
    const running = runWorkspaceTaskSuite(suite(task({ trials: 2 })), {
      signal: abort.signal,
      providerFactory: stage === "provider" ? waitingFactory : () => provider,
      ...(stage === "execution" ? { allowShell: true, executionFactory: waitingFactory } : {}),
    });
    await started.promise;
    abort.abort();
    const result = await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error("cancel timeout")), 500))]);
    assert.equal(result.cancelled, true);
    assert.equal(result.score.notRun, 1);
    await assert.rejects(fs.access(workspace));
    pending.resolve(stage === "provider" ? provider : execution);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(modelCalls, 0);
    assert.equal(executions, 0);
    await assert.rejects(fs.access(workspace));
  }
});

test("忽略取消的 Provider 不能阻止 suite 结束，迟到工具调用不会执行", async () => {
  const abort = new AbortController();
  const started = Promise.withResolvers();
  const pending = Promise.withResolvers();
  let workspace;
  const running = runWorkspaceTaskSuite(suite(task({ trials: 2 })), { signal: abort.signal,
    providerFactory: (context) => {
      workspace = context.workspace;
      return { name: "fixture", complete: () => { started.resolve(); return pending.promise; } };
    },
  });
  await started.promise;
  abort.abort();
  const report = await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error("cancel timeout")), 500))]);
  assert.equal(report.cancelled, true);
  assert.equal(report.results[0].phase, "cancelled");
  await assert.rejects(fs.access(workspace));
  pending.resolve(response("", [{ id: "late", name: "write_file", arguments: { path: "result.txt", content: "must not write" } }]));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(fs.access(workspace));
});

test("读取过程中最终路径被换成另一文件不能产生伪通过", async () => {
  const originalOpen = fs.open;
  let swapped = false;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (typeof args[0] !== "string" || !args[0].endsWith("/result.txt")) return handle;
    const read = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      const result = await read(...readArgs);
      if (!swapped) {
        swapped = true;
        await fs.rename(args[0], `${args[0]}.before`);
        await fs.writeFile(args[0], "wrong");
      }
      return result;
    };
    return handle;
  };
  try {
    const report = await runWorkspaceTaskSuite(suite(), { providerFactory: async ({ workspace }) => {
      await fs.writeFile(path.join(workspace, "result.txt"), "done");
      return { name: "fixture", complete: async () => response() };
    } });
    assert.equal(swapped, true);
    assert.equal(report.passed, false);
    assert.equal(report.results[0].checks[0].code, "file_changed");
  } finally { fs.open = originalOpen; }
});

test("忽略取消且永久挂起的流式 Provider 也能退出而不接收迟到事件", async () => {
  const abort = new AbortController();
  const started = Promise.withResolvers();
  const pending = Promise.withResolvers();
  let workspace;
  const running = runWorkspaceTaskSuite(suite(), { signal: abort.signal,
    providerFactory: (context) => {
      workspace = context.workspace;
      return { name: "fixture-stream", complete: async () => assert.fail("stream expected"),
        stream: () => ({ [Symbol.asyncIterator]() { return this; },
          next: () => { started.resolve(); return pending.promise; },
          return: () => new Promise(() => {}),
        }),
      };
    },
  });
  await started.promise;
  abort.abort();
  const report = await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error("cancel timeout")), 500))]);
  assert.equal(report.cancelled, true);
  await assert.rejects(fs.access(workspace));
  pending.resolve({ done: false, value: { type: "text_delta", delta: "late" } });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(fs.access(workspace));
});

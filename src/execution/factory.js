// FOUNDATION — trusted composition root for selecting the workspace execution boundary.
import { assertWorkspaceExecution } from "./interface.js";
import { DockerWorkspaceAdapter } from "./docker-workspace-adapter.js";
import { LocalWorkspaceAdapter } from "./local-workspace-adapter.js";
import { NativeSandboxAdapter } from "./native-sandbox-adapter.js";

export function createWorkspaceExecution(config, { environment = process.env, controlExecution = null } = {}) {
  if (!config || typeof config !== "object") throw new Error("创建 WorkspaceExecution 需要运行配置");
  const type = config.execution?.type || "local";
  if (type === "local") {
    return assertWorkspaceExecution(new LocalWorkspaceAdapter({ workspace: config.workspace, environment }));
  }
  if (type === "native") {
    return assertWorkspaceExecution(new NativeSandboxAdapter({
      workspace: config.workspace,
      environment,
      controlExecution,
    }));
  }
  if (type === "docker") {
    return assertWorkspaceExecution(new DockerWorkspaceAdapter({
      workspace: config.workspace,
      image: config.execution.dockerImage,
      environment,
      controlExecution,
    }));
  }
  throw new Error(`不支持的 WorkspaceExecution：${type}`);
}

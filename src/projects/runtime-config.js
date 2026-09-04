// FOUNDATION — pins trusted process-level configuration while switching Project workspaces.
import path from "node:path";

export function projectRuntimeArgs({ startupArgs = [], startupWorkspace, mcpFile = null, workspace } = {}) {
  if (!Array.isArray(startupArgs)) throw new TypeError("startupArgs 必须是数组");
  const sourceWorkspace = requiredPath(startupWorkspace, "Startup Workspace");
  const projectWorkspace = requiredPath(workspace, "Project Workspace");
  const args = startupArgs.filter((value) => (
    !String(value).startsWith("--workspace=")
    && !String(value).startsWith("--mcp=")
  ));
  if (mcpFile) args.push(`--mcp=${path.resolve(sourceWorkspace, mcpFile)}`);
  args.push(`--workspace=${projectWorkspace}`);
  return args;
}

function requiredPath(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} 必须是非空路径`);
  return path.resolve(value);
}

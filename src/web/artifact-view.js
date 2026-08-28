export function artifactIdFromToolResult(content) {
  if (typeof content !== "string") return null;
  return content.match(/完整输出已保存为 Artifact：(artifact-[A-Za-z0-9-]+)/)?.[1] || null;
}

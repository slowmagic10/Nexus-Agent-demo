// FOUNDATION — fail-closed validation shared by Docker configuration and runtime.
export function normalizeDockerImage(value) {
  if (typeof value !== "string") throw new Error("execution.dockerImage 必须是字符串");
  const image = value.trim();
  if (!image || image.length > 255 || image.startsWith("-") || image.includes("\0") || /\s/.test(image)) {
    throw new Error("execution.dockerImage 必须是合法的非空镜像引用");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$/.test(image)) {
    throw new Error("execution.dockerImage 包含不支持的字符");
  }
  return image;
}

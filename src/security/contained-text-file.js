// FOUNDATION — bounded, no-follow reads for text that may enter a model context.
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export async function readContainedTextFile(root, requested, { maxBytes = 256_000 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("maxBytes 必须是正安全整数");
  const canonicalRoot = await fs.realpath(path.resolve(root));
  const candidate = containedCandidate(canonicalRoot, requested);
  const parent = await fs.realpath(path.dirname(candidate));
  assertContained(canonicalRoot, parent);

  const before = await fs.lstat(candidate);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("上下文文件必须是普通文件，不能是符号链接");
  assertContained(canonicalRoot, await fs.realpath(candidate));

  let handle;
  try {
    handle = await fs.open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (["ELOOP", "EMLINK"].includes(error?.code)) throw new Error("上下文文件不能是符号链接");
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("上下文文件在读取期间发生变化");
    }
    const limit = Math.min(maxBytes, opened.size);
    const buffer = Buffer.alloc(limit);
    let offset = 0;
    while (offset < limit) {
      const { bytesRead } = await handle.read(buffer, offset, limit - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const decoder = new StringDecoder("utf8");
    const content = decoder.write(buffer.subarray(0, offset));
    return offset >= opened.size ? content + decoder.end() : content;
  } finally {
    await handle.close();
  }
}

export async function resolveContainedDirectory(root, requested = ".") {
  const canonicalRoot = await fs.realpath(path.resolve(root));
  const candidate = containedCandidate(canonicalRoot, requested);
  const before = await fs.lstat(candidate);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error("目录必须是真实目录，不能是符号链接");
  }
  const canonical = await fs.realpath(candidate);
  assertContained(canonicalRoot, canonical);
  return canonical;
}

function containedCandidate(root, requested) {
  if (typeof requested !== "string" || !requested) throw new TypeError("相对路径不能为空");
  const candidate = path.resolve(root, requested);
  assertContained(root, candidate);
  return candidate;
}

function assertContained(root, target) {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("上下文路径越过了工作区边界");
  }
}

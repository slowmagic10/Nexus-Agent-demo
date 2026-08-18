import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const LOCAL_ENV_FILES = [".env.local", ".env.deepseek.local"];

export function loadLocalEnvironment(root, { env = process.env } = {}) {
  for (const name of LOCAL_ENV_FILES) {
    const file = path.join(root, name);
    if (!existsSync(file)) continue;
    for (const [key, value] of parseEnvironment(readFileSync(file, "utf8"))) {
      if (env[key] === undefined) env[key] = value;
    }
    return { file, legacy: name !== ".env.local" };
  }
  return { file: null, legacy: false };
}

function parseEnvironment(source) {
  const entries = [];
  for (const sourceLine of source.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    entries.push([match[1], environmentValue(match[2])]);
  }
  return entries;
}

function environmentValue(raw) {
  const value = raw.trim();
  if (value.length >= 2 && value[0] === value.at(-1) && ["\"", "'"].includes(value[0])) {
    const content = value.slice(1, -1);
    return value[0] === "\""
      ? content.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\\"/g, "\"").replace(/\\\\/g, "\\")
      : content;
  }
  return value.replace(/\s+#.*$/, "").trimEnd();
}

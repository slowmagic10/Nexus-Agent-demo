const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "sk-[REDACTED]"],
  [/\bgh[opsu]_[A-Za-z0-9]{20,}\b/g, "gh_[REDACTED]"],
  [/\bAKIA[A-Z0-9]{16}\b/g, "AKIA[REDACTED]"],
  [/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]"],
  [/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))=([^\s]+)/g, "$1=[REDACTED]"],
];

export function redactSensitiveText(value) {
  let output = String(value ?? "");
  for (const [pattern, replacement] of SECRET_PATTERNS) output = output.replace(pattern, replacement);
  return output;
}

export function redactSensitiveValue(value) {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactSensitiveValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSensitiveValue(item)]));
  }
  return value;
}

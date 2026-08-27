const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "sk-[REDACTED]"],
  [/\bgh[opsu]_[A-Za-z0-9]{20,}\b/g, "gh_[REDACTED]"],
  [/\bAKIA[A-Z0-9]{16}\b/g, "AKIA[REDACTED]"],
  [/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]"],
  [/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))=([^\s]+)/g, "$1=[REDACTED]"],
  [/(\bsshpass\s+-p\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|\S+)/gi, "$1[REDACTED]"],
  [/(\bexpect\s+\S+\s+\S+\s+\S+\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|\S+)/gi, "$1[REDACTED]"],
  [/(["'])(?=[^"'\r\n]{8,}\1)(?=[^"'\r\n]*[A-Za-z])(?=[^"'\r\n]*\d)(?=[^"'\r\n]*[^A-Za-z0-9\s])[^"'\r\n]+\1/g, "$1[REDACTED]$1"],
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
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      isSensitiveKey(key) ? "[REDACTED]" : redactSensitiveValue(item),
    ]));
  }
  return value;
}

function isSensitiveKey(key) {
  const normalized = String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
  return /(?:^|_)(?:api_key|access_token|auth_token|bearer_token|refresh_token|client_secret|secret|password|authorization|credentials?)$/.test(normalized);
}

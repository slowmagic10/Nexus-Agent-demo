// Serialize values that have ALREADY been redacted by value. This is not a
// replacement for redactSensitiveValue and must never receive unredacted data.
export function serializeRedactedToolJson(value) {
  // ToolHost and durable dispatch still apply the legacy plain-text redactor.
  // Its shell/credential patterns may eat JSON delimiters after [REDACTED].
  // Escape pattern separators inside JSON string tokens only; JSON.parse sees
  // exactly the same data, while repeated text redaction cannot break framing.
  return JSON.stringify(value).replace(/"(?:\\.|[^"\\])*"/g, (token) => token.replace(
    /[:=\-是为]|expect/gi,
    (match) => `\\u${match.charCodeAt(0).toString(16).padStart(4, "0")}${match.slice(1)}`,
  ));
}

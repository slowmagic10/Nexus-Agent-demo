export const MEMORY_QUERY_MAX_CHARS = 4096;
const QUERY_LIMIT = MEMORY_QUERY_MAX_CHARS;
const TERM_LIMIT = 24;
const VERSION = "memory-keywords-v1";

const ENGLISH_STOP_WORDS = new Set([
  "a", "an", "the", "this", "that", "these", "those", "what", "which", "how", "why",
  "who", "where", "when", "is", "are", "was", "were", "be", "been", "do", "does",
  "did", "to", "of", "for", "with", "we", "our", "you", "your", "please",
]);
// Longest-first boundaries remove function words without joining their neighbors.
const CHINESE_STOP_PHRASES = [
  "为什么", "我们", "你们", "他们", "这个", "那个", "这些", "那些", "什么", "哪些",
  "怎么", "如何", "为何", "是否", "多少", "哪里", "请问", "的", "了", "吗",
  "呢", "啊", "和", "与", "及", "或", "在", "是",
];
const GENERIC_CHINESE_WORDS = ["项目", "使用"];
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD_START = /[\p{L}\p{N}]/u;
const WORD_CONTINUE = /[\p{L}\p{M}\p{N}_]/u;

/** Pure lexical expansion; the original literal remains available to the adapter. */
export function prepareMemoryQuery(input) {
  const query = String(input || "").trim();
  if (query.length > QUERY_LIMIT) throw new Error(`Memory 检索 query 不能超过 ${QUERY_LIMIT} 个 UTF-16 字符`);
  const candidates = new Map();
  let order = 0;
  function add(text, position, kind, weight = 1) {
    // Match SQLite's built-in lower(): ASCII folding only. Unicode expansion
    // here could turn an exact CAFÉ token into café, which SQL instr cannot find.
    const normalized = text.replace(/[A-Z]/g, (character) => character.toLowerCase());
    if (!normalized || (kind === "identifier" && ENGLISH_STOP_WORDS.has(normalized))) return;
    const previous = candidates.get(normalized);
    if (previous) {
      previous.weight = Math.max(previous.weight, weight);
      return;
    }
    candidates.set(normalized, { text: normalized, weight, position, kind, order: order++ });
  }

  // Input, token construction, and the number of grams are bounded by QUERY_LIMIT.
  // Iterate code points so astral Han characters are never cut into surrogates.
  const characters = Array.from(query);
  let position = 0;
  for (let index = 0; index < characters.length;) {
    const start = index;
    const startPosition = position;
    const isCjk = CJK.test(characters[index]);
    if (!isCjk && !WORD_START.test(characters[index])) {
      position += characters[index++].length;
      continue;
    }
    while (index < characters.length && (isCjk
      ? CJK.test(characters[index])
      : !CJK.test(characters[index]) && WORD_CONTINUE.test(characters[index]))) {
      position += characters[index++].length;
    }
    const token = characters.slice(start, index).join("");
    if (isCjk) addChineseTerms(token, startPosition, add);
    else addIdentifierTerms(token, startPosition, add);
  }

  const all = [...candidates.values()].sort(byPosition);
  const selected = selectTerms(all).sort(byPosition);
  const terms = selected.map(({ text, weight }) => ({ text, weight }));
  const indexed = terms.filter(({ text }) => Array.from(text).length >= 3);
  return {
    query,
    terms,
    matchExpression: indexed.length
      ? indexed.map(({ text }) => `"${text.replaceAll('"', '""')}"`).join(" OR ")
      : null,
    version: VERSION,
    termsTruncated: all.length > TERM_LIMIT,
  };
}

function addIdentifierTerms(token, position, add) {
  add(token, position, "identifier");
  // Splitting only at literal underscores or ASCII case transitions preserves
  // contiguous input substrings; no stemming or inferred synonyms are added.
  const parts = token.matchAll(/[^_]+/gu);
  for (const part of parts) {
    const boundaries = [0];
    for (let index = 1; index < part[0].length; index += 1) {
      const before = part[0][index - 1];
      const current = part[0][index];
      const after = part[0][index + 1] || "";
      if (/[a-z0-9]/.test(before) && /[A-Z]/.test(current)
        || /[A-Z]/.test(before) && /[A-Z]/.test(current) && /[a-z]/.test(after)) boundaries.push(index);
    }
    boundaries.push(part[0].length);
    for (let index = 1; index < boundaries.length; index += 1) {
      add(part[0].slice(boundaries[index - 1], boundaries[index]), position + part.index + boundaries[index - 1], "identifier");
    }
  }
}

function addChineseTerms(token, position, add) {
  let segment = "";
  let segmentPosition = position;
  function flush() {
    const characters = Array.from(segment);
    if (characters.length === 1) add(segment, segmentPosition, "cjk");
    let offset = 0;
    for (let index = 0; index < characters.length - 1; index += 1) {
      add(characters.slice(index, index + 2).join(""), segmentPosition + offset, "cjk");
      if (index + 2 < characters.length) add(characters.slice(index, index + 3).join(""), segmentPosition + offset, "cjk");
      offset += characters[index].length;
    }
    segment = "";
  }
  for (let index = 0; index < token.length;) {
    const stop = CHINESE_STOP_PHRASES.find((word) => token.startsWith(word, index));
    const generic = stop ? null : GENERIC_CHINESE_WORDS.find((word) => token.startsWith(word, index));
    if (stop || generic) {
      flush();
      if (generic) add(generic, position + index, "generic", 0.25);
      index += (stop || generic).length;
      segmentPosition = position + index;
    } else {
      const character = String.fromCodePoint(token.codePointAt(index));
      segment += character;
      index += character.length;
    }
  }
  flush();
}

function selectTerms(all) {
  if (all.length <= TERM_LIMIT) return all;
  const identifiers = all.filter(({ kind }) => kind === "identifier");
  const cjk = all.filter(({ kind }) => kind === "cjk");
  // Favor identifiers while retaining room for content elsewhere in mixed input.
  const selected = sample(identifiers, cjk.length ? 16 : TERM_LIMIT);
  const selectedSet = new Set(selected);
  const remaining = all.filter((term) => term.kind !== "generic" && !selectedSet.has(term));
  selected.push(...sample(remaining, TERM_LIMIT - selected.length));
  selected.push(...sample(all.filter(({ kind }) => kind === "generic"), TERM_LIMIT - selected.length));
  return selected;
}

function sample(items, count) {
  if (count <= 0) return [];
  if (items.length <= count) return items;
  if (count === 1) return [items.at(-1)];
  return Array.from({ length: count }, (_, index) => items[Math.floor(index * (items.length - 1) / (count - 1))]);
}

function byPosition(left, right) {
  return left.position - right.position || left.order - right.order;
}

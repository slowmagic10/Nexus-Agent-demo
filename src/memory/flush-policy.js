import { createHash } from "node:crypto";
import { redactSensitiveText } from "../security/redact.js";
import { normalizeMemoryCandidate } from "./interface.js";
import { executeMemoryMutation } from "./outbox.js";

const EXTRACTION_PROMPT = `你负责从单轮 Agent 对话中提出长期记忆候选。
只保留未来对话仍有价值、且能由当前对话直接支持的稳定事实、偏好、决定或经验。
不要提取密码、API Key、Authorization、一次性请求、临时状态或未经证据支持的推断。
只输出 JSON 数组，不要解释。每项格式：
{"content":"简洁事实","kind":"preference|fact|decision|lesson|task|profile","confidence":0.0,"tags":[]}
没有合适内容时输出 []。最多 5 项。`;

export class MemoryFlushPolicy {
  constructor({ memory, extractCandidates, timeoutMs = 5_000, maxCandidates = 5 }) {
    if (!memory || typeof memory.search !== "function" || typeof memory.add !== "function") {
      throw new Error("MemoryFlushPolicy 需要 Memory Adapter");
    }
    if (typeof extractCandidates !== "function") throw new Error("MemoryFlushPolicy 需要 candidate extractor");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Memory flush timeoutMs 必须是正整数");
    if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1) throw new Error("Memory flush maxCandidates 必须是正整数");
    this.memory = memory;
    this.extractCandidates = extractCandidates;
    this.timeoutMs = timeoutMs;
    this.maxCandidates = maxCandidates;
  }

  async flush({ session, messages, sourceCursor, signal } = {}) {
    if (!session || !Number.isSafeInteger(sourceCursor) || sourceCursor < 1) {
      throw new Error("Memory flush 需要 Session 和来源 cursor");
    }
    const flushSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
      : AbortSignal.timeout(this.timeoutMs);
    await session.dispatch({ type: "MEMORY_FLUSH_REQUESTED", sourceCursor });
    try {
      const extracted = await raceWithSignal(this.extractCandidates({
        messages: structuredClone(messages || []),
        scope: session.state.memoryScope,
        sourceCursor,
        signal: flushSignal,
      }), flushSignal);
      if (!Array.isArray(extracted)) throw new Error("Memory candidate extractor 必须返回数组");
      const candidates = extracted
        .map(normalizeExtractedCandidate)
        .filter(Boolean)
        .slice(0, this.maxCandidates);
      const created = [];
      let skipped = extracted.length - candidates.length;
      for (const candidate of candidates) {
        const existing = await this.memory.search(candidate.content, {
          scope: session.state.memoryScope,
          signal: flushSignal,
        }, { limit: 20, statuses: ["active", "candidate"] });
        if (existing.some((record) => sameContent(record.content, candidate.content))) {
          skipped += 1;
          continue;
        }
        const mutation = {
          id: flushMutationId(session.id, sourceCursor, candidate),
          operation: "add",
          candidate: { ...candidate, status: "candidate" },
          scope: session.state.memoryScope,
          provenance: {
            origin: "auto_extract",
            sessionId: session.id,
            sourceCursor,
            model: session.state.provider,
          },
        };
        const record = await executeMemoryMutation({
          memory: this.memory,
          dispatch: (action) => session.dispatch(action),
          mutation,
          signal: flushSignal,
        });
        created.push(record);
        await session.dispatch({
          type: "MEMORY_CANDIDATE_CREATED",
          memoryId: record.id,
          sourceCursor,
          preview: candidate.content.slice(0, 120),
        });
      }
      await session.dispatch({
        type: "MEMORY_FLUSH_COMPLETED",
        sourceCursor,
        extracted: extracted.length,
        created: created.length,
        skipped,
      });
      return created;
    } catch (error) {
      await session.dispatch({
        type: "MEMORY_FLUSH_DEGRADED",
        sourceCursor,
        error: redactSensitiveText(error?.message || "Memory flush 失败"),
      });
      return [];
    }
  }
}

export function createModelMemoryExtractor(provider) {
  if (!provider || typeof provider.complete !== "function") throw new Error("Memory extractor 需要模型 Provider");
  if (provider.name === "offline-demo") return async () => [];
  return async ({ messages, signal }) => {
    const transcript = messages
      .map((message) => `${message.role}: ${redactSensitiveText(message.content || "")}`)
      .join("\n")
      .slice(-16_000);
    const response = await provider.complete({
      systemPrompt: EXTRACTION_PROMPT,
      messages: [{ role: "user", content: transcript }],
      tools: [],
      signal,
    });
    return parseCandidateResponse(response?.text);
  };
}

function normalizeExtractedCandidate(candidate) {
  try {
    const normalized = normalizeMemoryCandidate({
      ...candidate,
      content: redactSensitiveText(candidate?.content),
      status: "candidate",
    });
    return {
      content: normalized.content,
      kind: normalized.kind,
      confidence: normalized.confidence,
      tags: normalized.tags,
      observedAt: normalized.observedAt,
      expiresAt: normalized.expiresAt,
    };
  } catch {
    return null;
  }
}

function parseCandidateResponse(value) {
  const text = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!text) return [];
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    const array = text.match(/\[[\s\S]*\]/)?.[0];
    if (!array) throw new Error("模型没有返回合法的 Memory candidate JSON");
    payload = JSON.parse(array);
  }
  if (!Array.isArray(payload)) throw new Error("模型返回的 Memory candidate 必须是数组");
  return payload;
}

function flushMutationId(sessionId, sourceCursor, candidate) {
  const hash = createHash("sha256").update(JSON.stringify({
    sourceCursor,
    content: candidate.content.toLowerCase(),
    kind: candidate.kind,
  })).digest("hex").slice(0, 16);
  return `${sessionId}:memory-flush:${sourceCursor}:${hash}`;
}

function sameContent(left, right) {
  return String(left).trim().toLowerCase() === String(right).trim().toLowerCase();
}

function raceWithSignal(operation, signal) {
  if (signal.aborted) return Promise.reject(signal.reason || new Error("Memory flush 已取消"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new Error("Memory flush 已取消"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

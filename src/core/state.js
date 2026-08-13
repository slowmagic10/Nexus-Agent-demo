// PROTOTYPE: portable state machine for an executable Agent session.

export function createSession({ provider, workspace }) {
  return {
    id: `session-${Date.now().toString(36)}`,
    phase: "idle",
    provider,
    workspace,
    messages: [],
    events: [],
    memory: [],
    loadedSkills: [],
    pendingApproval: null,
    step: 0,
    metrics: { modelCalls: 0, toolCalls: 0, approvals: 0 },
    lastError: null,
  };
}

export function reduceSession(state, action) {
  const next = structuredClone(state);
  const emit = (type, detail = {}) => {
    next.events.push({
      seq: next.events.length + 1,
      at: new Date().toISOString(),
      type,
      ...detail,
    });
  };

  switch (action.type) {
    case "USER_MESSAGE":
      next.phase = "thinking";
      next.messages.push({ role: "user", content: action.content });
      emit("message.user", { preview: action.content.slice(0, 120) });
      break;
    case "MODEL_REQUESTED":
      next.phase = "thinking";
      next.step += 1;
      next.metrics.modelCalls += 1;
      emit("model.requested", { step: next.step });
      break;
    case "ASSISTANT_MESSAGE":
      next.messages.push(action.message);
      emit("message.assistant", { preview: (action.message.content || "[工具调用]").slice(0, 120) });
      break;
    case "TOOL_REQUESTED":
      next.phase = "executing";
      next.metrics.toolCalls += 1;
      emit("tool.requested", { tool: action.call.name, args: action.call.arguments });
      break;
    case "APPROVAL_REQUESTED":
      next.phase = "awaiting_approval";
      next.pendingApproval = action.call;
      emit("approval.requested", { tool: action.call.name, args: action.call.arguments });
      break;
    case "APPROVAL_DECIDED":
      next.metrics.approvals += 1;
      next.pendingApproval = null;
      next.phase = action.approved ? "executing" : "thinking";
      emit(action.approved ? "approval.granted" : "approval.denied", { tool: action.call.name });
      break;
    case "TOOL_RESULT":
      next.messages.push({ role: "tool", tool_call_id: action.call.id, content: action.result });
      next.phase = "thinking";
      emit("tool.completed", { tool: action.call.name, ok: action.ok, preview: action.result.slice(0, 160) });
      break;
    case "MEMORY_ADDED":
      next.memory.push({ content: action.content, at: new Date().toISOString() });
      emit("memory.added", { preview: action.content.slice(0, 120) });
      break;
    case "SKILL_LOADED":
      if (!next.loadedSkills.some((skill) => skill.name === action.skill.name)) {
        next.loadedSkills.push(action.skill);
      }
      emit("skill.loaded", { skill: action.skill.name });
      break;
    case "COMPLETED":
      next.phase = "completed";
      emit("session.turn_completed");
      break;
    case "FAILED":
      next.phase = "failed";
      next.lastError = action.error;
      emit("session.failed", { error: action.error });
      break;
    case "READY":
      next.phase = "idle";
      next.lastError = null;
      break;
    default:
      throw new Error(`未知状态动作：${action.type}`);
  }

  return next;
}

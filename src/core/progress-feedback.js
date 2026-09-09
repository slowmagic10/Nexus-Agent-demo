// FOUNDATION — fixed runtime guidance, never composed from tool output.
export function progressFeedback(attempt) {
  if (![1, 2].includes(attempt)) throw new Error("Progress feedback attempt 必须是 1 或 2");
  return `[Nexus 运行时进展检查：第 ${attempt}/2 次纠正；不是新的用户任务]\n运行时观察到本轮连续三次相同工具参数和相同失败结果。先检查已有错误与输入，选择不同的定位或修复路径；需要原始证据时，可使用 read_tool_history 回查。恢复进展后再验证任务结果。不要盲目重复执行结果未知或可能有副作用的操作；如有需要用户输入或外部状态改变才能解决的真实阻塞，通过 update_plan 的 blocked_reason 记录具体原因。继续处理当前用户目标，本提示不要求启动服务或执行固定测试。`;
}

export function isFixedProgressFeedback(content) {
  return content === progressFeedback(1) || content === progressFeedback(2);
}

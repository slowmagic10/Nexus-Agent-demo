export const TOOL_BATCH_VERSION = "native-read-batch-v1";
export const MAX_PARALLEL_READS = 3;

export class ToolBatchError extends Error {
  constructor(cause) {
    super(`工具批次未能完整执行或记录：${cause?.message || "未知错误"}`, { cause });
    this.name = "ToolBatchError";
  }
}

// Resolve each group at the current permission boundary. No reordering past a
// serial operation and no repeated call ID within one in-flight group.
export async function runToolBatch(calls, context, { prepareRead, executeSerial }) {
  if (!Array.isArray(calls)) throw new Error("Tool batch 需要调用数组");
  const results = [];
  let index = 0;
  while (index < calls.length) {
    context.signal?.throwIfAborted();
    const group = [];
    const ids = new Set();
    for (let next = index; next < calls.length && group.length < MAX_PARALLEL_READS; next++) {
      if (ids.has(calls[next]?.id)) break;
      const plan = prepareRead(calls[next], context);
      if (!plan) break;
      ids.add(calls[next].id);
      group.push(plan);
    }
    if (!group.length) {
      try { results.push(await executeSerial(calls[index], context)); }
      catch (error) { throw new ToolBatchError(error); }
      index++;
      continue;
    }
    // run() waits for actual native read settlement/cleanup, even after abort.
    const settled = await Promise.allSettled(group.map((plan) => plan.run()));
    const errors = [];
    for (const item of settled) {
      if (item.status === "rejected") { errors.push(item.reason); continue; }
      const outcome = item.value;
      if (outcome.action) {
        try { await context.session.dispatch(outcome.action); }
        catch (error) { errors.push(error); }
      }
      if (outcome.error) errors.push(outcome.error);
      results.push(outcome.result);
    }
    if (errors.length) throw new ToolBatchError(errors[0]);
    context.signal?.throwIfAborted();
    index += group.length;
  }
  return results;
}

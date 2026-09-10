// Frozen stage 16 source-read path. Request policy remains shared deliberately:
// this reference isolates full-history snapshot copying from source projection.
import { readSessionState } from "../../src/core/session-state-view.js";
import {
  ContextSummaryRequestBudgetError,
  planContextSummaryRequest,
  selectContextSummaryBatch,
} from "../../src/core/context-summary.js";

export function prepareReferenceSessionSummary(session, {
  fromMessage = 0, throughMessage, usesModel = true, maxInputTokens = 32_000,
} = {}) {
  const source = readSessionState(session, ["messages", "contextSummary"]);
  const sourceCursor = session.cursor;
  if (usesModel) {
    try {
      const planned = planContextSummaryRequest({ messages: source.messages, previousSummary: source.contextSummary,
        fromMessage, throughMessage, maxInputTokens });
      return { sourceCursor, batch: planned.batch, previousSummary: planned.input.previousSummary,
        sourceComplete: planned.input.sourceComplete, request: planned.request };
    } catch (error) {
      if (error instanceof ContextSummaryRequestBudgetError) error.sourceCursor = sourceCursor;
      throw error;
    }
  }
  const batch = selectContextSummaryBatch(source.messages, { fromMessage, throughMessage });
  return { sourceCursor, batch, previousSummary: source.contextSummary,
    sourceComplete: batch.sourceComplete && source.contextSummary?.sourceComplete !== false, request: null };
}

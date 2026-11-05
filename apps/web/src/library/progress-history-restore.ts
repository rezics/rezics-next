import type { ProgressChange, ProgressRecordInput, ProgressSessionView } from './progress-reads';

export type HistoryRecord = Omit<ProgressRecordInput, 'sessionId' | 'revision' | 'idempotencyKey'>;

/** Restore one retained intent as a new correction, never as a historical receipt or reconstructed snapshot. */
export function progressHistoryRecord(session: ProgressSessionView, change: ProgressChange): HistoryRecord | undefined {
  if (change.action) return;
  const measure =
    change.measureId === undefined ? undefined : session.measures?.find((m) => m.unit === change.measureId);
  if (change.measureId !== undefined && !measure && change.measureId !== session.unit) return;
  const target = change.measureId === undefined ? {} : { measureId: change.measureId };
  if (change.cleared) return { ...target, clear: true };
  const meaning = measure ? measure.meaning : session.meaning;
  const recording = measure ? measure.recordingState : session.recordingState;
  if (session.state !== 'active' || meaning !== 'known' || recording !== 'supported') return;
  if (session.mode === 'scalar_amount' && change.amount !== null) return { ...target, amount: change.amount };
  if (session.mode === 'cursor_position' && change.locator !== null && change.position !== null)
    return { locator: change.locator, position: change.position };
  if (session.mode === 'completed_units' && (change.add.length || change.remove.length))
    return {
      ...(change.add.length ? { add: [...change.add] } : {}),
      ...(change.remove.length ? { remove: [...change.remove] } : {}),
    };
}

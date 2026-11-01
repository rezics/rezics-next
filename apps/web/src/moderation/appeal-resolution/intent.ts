import type { AppealResolutionResult } from '../actions';

export type ResolutionCommand = Readonly<{
  id: string;
  outcome: 'uphold' | 'reverse';
  statement: string;
  idempotencyKey: string;
}>;

/** Memory belongs to one mounted private view. Retirement is irreversible; retries never create intent. */
export function createAppealResolutionIntent(appealId: string) {
  let viewer: string | null = null;
  let admitted = false;
  let command: ResolutionCommand | null = null;
  let phase: 'draft' | 'pending' | 'uncertain' | 'settled' | 'retired' = 'draft';
  let result: AppealResolutionResult | null = null;
  return {
    get phase() {
      return phase;
    },
    get command() {
      return command;
    },
    get result() {
      return result;
    },
    synchronize(id: string, currentViewer: string | null, mayResolve: boolean) {
      // Initial hydration may establish a viewer, but can never adopt a submitted fixture intent.
      if (
        id !== appealId ||
        ((viewer !== null || command !== null) && viewer !== currentViewer) ||
        (admitted && !mayResolve)
      ) {
        phase = 'retired';
        command = null;
        result = null;
      }
      viewer = currentViewer;
      admitted ||= mayResolve;
    },
    begin(outcome: ResolutionCommand['outcome'], statement: string): ResolutionCommand | null {
      const trimmed = statement.trim();
      const count = Array.from(trimmed).length;
      if (phase !== 'draft' || !admitted || count < 1 || count > 2000) return null;
      command = Object.freeze({ id: appealId, outcome, statement: trimmed, idempotencyKey: crypto.randomUUID() });
      phase = 'pending'; // Lock synchronously, before React renders or the transport starts.
      return command;
    },
    retry(): ResolutionCommand | null {
      if (phase !== 'uncertain') return null;
      phase = 'pending';
      return command;
    },
    settle(response: AppealResolutionResult) {
      if (phase !== 'pending') return;
      result = response;
      phase = 'settled';
    },
    uncertain() {
      if (phase === 'pending') phase = 'uncertain';
    },
  };
}

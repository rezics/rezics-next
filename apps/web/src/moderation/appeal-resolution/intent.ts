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
  let statement = '';
  let command: ResolutionCommand | null = null;
  let phase: 'draft' | 'pending' | 'uncertain' | 'settled' | 'retired' = 'draft';
  let result: AppealResolutionResult | null = null;
  const retire = () => {
    if (phase === 'retired') return false;
    phase = 'retired';
    statement = '';
    command = null;
    result = null;
    return true;
  };
  return {
    get phase() {
      return phase;
    },
    /** These phases require this mounted command's exact recovery context. */
    get unresolved() {
      return phase === 'pending' || phase === 'uncertain';
    },
    get needsDecision() {
      return phase !== 'retired' && result?.state !== 'resolved' && statement.trim() !== '';
    },
    get command() {
      return command;
    },
    get result() {
      return result;
    },
    get statement() {
      return statement;
    },
    retire,
    synchronize(id: string, currentViewer: string | null, mayResolve: boolean) {
      // Hydration may establish a viewer only before this form owns private input or a command.
      if (
        id !== appealId ||
        ((viewer !== null || statement !== '' || command !== null) && viewer !== currentViewer) ||
        (admitted && !mayResolve)
      )
        retire();
      viewer = currentViewer;
      admitted ||= mayResolve;
    },
    edit(value: string) {
      if (phase !== 'draft' || !admitted) return false;
      statement = value;
      return true;
    },
    begin(outcome: ResolutionCommand['outcome']): ResolutionCommand | null {
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

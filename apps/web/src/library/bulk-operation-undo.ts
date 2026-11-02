import type { BulkOperation, OperationAddress, ReadFailure } from './bulk-operation-recovery-native';
import type { BulkUndoOutcome, BulkUndoRead } from './bulk-operation-undo-evidence';
import type { LibraryRestoreInput, LibraryRestoreResult } from './entries-read';

export function bulkOperationUndoHref(locale: string, id: string) {
  return `/${encodeURIComponent(locale)}/library/operations/${encodeURIComponent(id)}/undo`;
}

/** Only the dedicated authorized result route can supply this subject-bound receipt. */
export function undoOperand(operation: BulkOperation, outcome: BulkUndoOutcome, now = Date.now()) {
  const receipt = outcome.deletion;
  if (
    operation.action !== 'remove_from_library' ||
    outcome.state !== 'applied' ||
    outcome.memberId ||
    !receipt ||
    !receipt.deletionId ||
    !Number.isSafeInteger(receipt.revision) ||
    receipt.revision < 1 ||
    !Number.isFinite(Date.parse(receipt.restoreUntil)) ||
    Date.parse(receipt.restoreUntil) <= now
  )
    return;
  return { subjectId: outcome.subjectId, ...receipt };
}

export type UndoTarget = OperationAddress & { ordinal: string; subjectId: string; csrf: string };
export type PreparedUndo = LibraryRestoreInput & { restoreUntil: string };
export type UndoPreparation = { state: 'ready'; undo: PreparedUndo } | { state: ReadFailure };
export type RestoreSender = (input: { data: LibraryRestoreInput; headers: Headers }) => Promise<LibraryRestoreResult>;
type Access = {
  current: () => boolean;
  capture: () => () => boolean;
  captureRestore: () => () => boolean;
  restore: () => boolean;
  csrf: () => string;
  headers: () => Headers;
};
type Transport = {
  read: (address: OperationAddress) => Promise<BulkUndoRead>;
  prepare: (target: UndoTarget, headers: Headers) => Promise<UndoPreparation>;
  sender: () => RestoreSender;
};
export type UndoAttempt = {
  status: 'sending' | 'uncertain' | 'finished';
  command: PreparedUndo;
  headers: Headers;
  send: RestoreSender;
  result?: LibraryRestoreResult;
};
export type UndoState = {
  read: BulkUndoRead['state'] | 'loading';
  operation?: BulkOperation;
  page?: Extract<BulkUndoRead, { state: 'ready' }>['page'] | undefined;
  cursor?: string | undefined;
  preparing?: string | undefined;
  failure?: ReadFailure | undefined;
};

/** Mounted memory only. Recovering a read never replaces a captured restore. */
export class BulkOperationUndo {
  state: UndoState = { read: 'loading' };
  readonly attempts = new Map<string, UndoAttempt>();
  private live = true;
  private reading = false;
  private sending = false;
  constructor(
    readonly address: Readonly<{ id: string; viewer: string }>,
    private access: Access,
    private transport: Transport,
    private changed: () => void,
  ) {}
  retire() {
    this.live = false;
  }
  get busy() {
    return this.sending;
  }
  private current() {
    return this.live && this.access.current();
  }
  private publish() {
    if (this.current()) this.changed();
  }
  async read(cursor = this.state.cursor) {
    if (!this.current() || this.reading) return;
    const current = this.access.capture();
    this.reading = true;
    this.state = { ...this.state, read: 'loading', cursor, page: undefined };
    this.publish();
    let result: BulkUndoRead;
    try {
      result = await this.transport.read({ ...this.address, ...(cursor === undefined ? {} : { cursor }) });
    } catch {
      result = { state: 'unavailable' };
    }
    this.reading = false;
    if (!this.current() || !current()) return;
    if (result.state === 'ready' && result.operation.id !== this.address.id) result = { state: 'unavailable' };
    this.state =
      result.state === 'ready'
        ? { ...this.state, read: 'ready', operation: result.operation, page: result.page }
        : { ...this.state, read: result.state, page: undefined };
    this.publish();
  }
  more() {
    if (this.state.page?.next) return this.read(this.state.page.next);
  }
  async restore(ordinal: string, retry = false) {
    if (!this.current() || this.sending || !this.access.restore()) return;
    let attempt = this.attempts.get(ordinal);
    if (retry ? attempt?.status !== 'uncertain' : !!attempt) return;
    const current = this.access.captureRestore();
    const send = this.transport.sender();
    this.sending = true;
    try {
      if (!attempt) {
        const { operation, page } = this.state;
        const row = page?.outcomes.find((item) => item.ordinal === ordinal);
        if (this.state.read !== 'ready' || !operation || !row || !undoOperand(operation, row) || !this.access.csrf())
          return;
        const headers = new Headers(this.access.headers());
        const csrf = this.access.csrf();
        if (headers.get('x-csrf-token') !== csrf) return;
        this.state = { ...this.state, preparing: ordinal, failure: undefined };
        this.publish();
        const prepared = await this.transport.prepare(
          {
            ...this.address,
            ordinal,
            subjectId: row.subjectId,
            csrf,
            ...(this.state.cursor === undefined ? {} : { cursor: this.state.cursor }),
          },
          new Headers(headers),
        );
        if (!this.current() || !current() || !this.access.restore()) return;
        if (prepared.state !== 'ready') {
          this.state = { ...this.state, failure: prepared.state };
          return;
        }
        // The preparation response is bound to this exact native target; reads cannot substitute operands.
        const original = undoOperand(operation, row);
        if (
          !original ||
          prepared.undo.subjectId !== original.subjectId ||
          prepared.undo.deletionId !== original.deletionId ||
          prepared.undo.revision !== original.revision ||
          prepared.undo.restoreUntil !== original.restoreUntil
        ) {
          this.state = { ...this.state, failure: 'invalid' };
          return;
        }
        attempt = { command: Object.freeze(prepared.undo), headers, send, status: 'sending' };
        this.attempts.set(ordinal, attempt);
      }
      attempt.status = 'sending';
      this.publish();
      let result: LibraryRestoreResult;
      try {
        result = await attempt.send({ data: attempt.command, headers: new Headers(attempt.headers) });
      } catch {
        result = { ok: false, reason: 'unavailable' };
      }
      attempt.status =
        !result.ok && ['unavailable', 'closed', 'signed-out'].includes(result.reason) ? 'uncertain' : 'finished';
      if (!this.current() || !current()) {
        attempt.status = 'uncertain';
        return;
      }
      attempt.result = result;
    } catch {
      this.state = { ...this.state, failure: 'unavailable' };
    } finally {
      this.sending = false;
      this.state = { ...this.state, preparing: undefined };
      this.publish();
    }
  }
}

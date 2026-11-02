import { reviewRequest, grantRequest, transferRequest } from './request';
import { parseOwnerTransfer, type OwnerTransfer } from './owner-transfer.ts';
import type { AccessIO, AccessState, Change, WriteResult } from './data';

export type EditorState = {
  page: AccessState;
  phase: 'idle' | WriteResult['status'];
  busy: boolean;
  reconciling: boolean;
  pending: Change | OwnerTransfer | null;
};

/** One immutable operation survives transport loss. A receipt never replaces a current read. */
export class AccessRecovery {
  private listeners = new Set<() => void>();
  private state: EditorState;
  private generation = 0;
  private active = true;
  private request = new AbortController();
  constructor(
    page: AccessState,
    private io: AccessIO,
  ) {
    this.state = { page, phase: 'idle', busy: false, reconciling: false, pending: null };
  }
  snapshot = () => this.state;
  /** Effect replay may reattach this controller, but never its old continuations. */
  activate = () => {
    if (!this.active) {
      this.active = true;
      this.request = new AbortController();
      void this.reload();
    }
    return this.dispose;
  };
  /** Departure retires local continuations without cancelling or replaying the dispatched command. */
  retire = () => {
    this.active = false;
    this.generation++;
  };
  dispose = () => {
    this.retire();
    if (!this.state.pending) this.request.abort();
    // A retired write may still commit. Only explicit retry may resolve its exact command.
    this.state = {
      ...this.state,
      page: { status: 'unavailable' },
      busy: false,
      phase: this.state.busy && this.state.pending ? 'uncertain' : this.state.phase,
    };
  };
  /** A deliberate local replacement starts fresh without replaying the abandoned command. */
  abandon = () => {
    this.retire();
    this.request = new AbortController();
    this.active = true;
    this.update({ pending: null, busy: false, reconciling: false, phase: 'idle' });
  };
  private owns(generation: number) {
    return this.active && generation === this.generation;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<EditorState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private async current(cursor?: string) {
    try {
      return await reviewRequest((signal) => this.io.read(cursor, signal), this.request.signal);
    } catch {
      return { status: 'unavailable' as const };
    }
  }
  async reload(cursor?: string) {
    if (!this.active || this.state.busy) return;
    const generation = ++this.generation;
    this.update({ busy: true, page: { status: 'loading' } });
    const page = await this.current(cursor);
    if (this.owns(generation)) this.update({ page, busy: false });
  }
  async submit(change: Omit<Change, 'key'>) {
    if (!this.active || this.state.busy || this.state.pending) return;
    const pending = structuredClone({ ...change, key: crypto.randomUUID() });
    this.update({ pending });
    await this.attempt(pending);
  }
  async submitTransfer(input: Omit<OwnerTransfer, 'key' | 'kind'>) {
    if (!this.active || this.state.busy || this.state.pending || !this.io.transfer) return;
    const pending = parseOwnerTransfer({ ...input, kind: 'realm-owner-transfer', key: crypto.randomUUID() });
    this.update({ pending });
    await this.attempt(pending);
  }
  async retry() {
    if (!this.active || this.state.busy || !this.state.pending) return;
    await this.attempt(this.state.pending);
  }
  private async attempt(pending: Change | OwnerTransfer) {
    const generation = ++this.generation;
    this.update({ busy: true });
    let result: WriteResult;
    let current: AccessState | undefined;
    try {
      if (pending.kind === 'realm-owner-transfer') {
        const transfer = await transferRequest(
          (signal) => this.io.transfer!(structuredClone(pending), signal),
          this.request.signal,
        );
        result = transfer;
        current = transfer.current;
      } else
        result = await grantRequest((signal) => this.io.save(structuredClone(pending), signal), this.request.signal);
    } catch {
      result = { status: 'uncertain' };
    }
    if (!this.owns(generation)) return;
    // Clear all old ACL data before a current authorization/disclosure read.
    this.update({
      page: { status: 'loading' },
      phase: result.status,
      reconciling: true,
      pending: result.status === 'uncertain' || result.status === 'preparing' ? pending : null,
    });
    const page = current ?? (await this.current());
    if (this.owns(generation)) this.update({ page, busy: false, reconciling: false });
  }
}

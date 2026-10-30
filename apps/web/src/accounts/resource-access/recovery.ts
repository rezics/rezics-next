import type { AccessIO, AccessState, Change, WriteResult } from './data';

export type EditorState = {
  page: AccessState;
  phase: 'idle' | WriteResult['status'];
  busy: boolean;
  pending: Change | null;
};

/** One immutable operation survives transport loss. A receipt never replaces a current read. */
export class AccessRecovery {
  private listeners = new Set<() => void>();
  private state: EditorState;
  constructor(
    page: AccessState,
    private io: AccessIO,
  ) {
    this.state = { page, phase: 'idle', busy: false, pending: null };
  }
  snapshot = () => this.state;
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
      return await this.io.read(cursor);
    } catch {
      return { status: 'unavailable' as const };
    }
  }
  async reload(cursor?: string) {
    if (this.state.busy) return;
    this.update({ busy: true, page: { status: 'loading' } });
    this.update({ page: await this.current(cursor), busy: false });
  }
  async submit(change: Omit<Change, 'key'>) {
    if (this.state.busy || this.state.pending) return;
    const pending = structuredClone({ ...change, key: crypto.randomUUID() });
    this.update({ pending });
    await this.attempt(pending);
  }
  async retry() {
    if (this.state.busy || !this.state.pending) return;
    await this.attempt(this.state.pending);
  }
  private async attempt(pending: Change) {
    this.update({ busy: true });
    let result: WriteResult;
    try {
      result = await this.io.save(structuredClone(pending));
    } catch {
      result = { status: 'uncertain' };
    }
    // Clear all old ACL data before a current authorization/disclosure read.
    this.update({
      page: { status: 'loading' },
      phase: result.status,
      pending: result.status === 'uncertain' || result.status === 'preparing' ? pending : null,
    });
    this.update({ page: await this.current(), busy: false });
  }
}

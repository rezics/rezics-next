import type {
  EntryAnnotationCorrectionPage,
  EntryAnnotationCorrectionSelection,
  EntryAnnotationCorrectionCancelResult,
} from '@rezics/client';
import type { CorrectionCommand, CorrectionPort } from './native';
import type { PrivateEntryRead } from '../rich-private-entry/native';

export type CorrectionState = {
  page: EntryAnnotationCorrectionPage | null;
  cancellation: EntryAnnotationCorrectionCancelResult | null;
  command: CorrectionCommand | null;
  busy: boolean;
  uncertain: boolean;
  rejected: number | null;
  current: Readonly<Record<string, PrivateEntryRead>>;
};

/** One visit owns one bounded review and at most one unresolved original command. */
export class SelectedCorrection {
  private state: CorrectionState = {
    page: null,
    cancellation: null,
    command: null,
    busy: false,
    uncertain: false,
    rejected: null,
    current: {},
  };
  private listeners = new Set<() => void>();
  private active = true;
  constructor(
    private port: CorrectionPort,
    private isCurrent: () => boolean,
    private refreshEntries: () => Promise<void>,
  ) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private current() {
    return this.active && this.isCurrent();
  }
  private update(patch: Partial<CorrectionState>) {
    if (!this.current()) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  retire = () => {
    this.active = false;
    this.state = {
      page: null,
      cancellation: null,
      command: null,
      busy: false,
      uncertain: false,
      rejected: null,
      current: {},
    };
    this.listeners.forEach((listener) => listener());
  };
  async create(items: EntryAnnotationCorrectionSelection[]) {
    if (!this.current() || this.state.command || this.state.busy || this.state.page) return;
    await this.dispatch({ kind: 'create', items: structuredClone(items), key: crypto.randomUUID() });
  }
  async confirm(position: number) {
    const page = this.state.page;
    if (
      !this.current() ||
      this.state.command ||
      this.state.busy ||
      !page ||
      page.state !== 'open' ||
      this.state.cancellation !== null
    )
      return;
    await this.dispatch({
      kind: 'confirm',
      reviewId: page.reviewId,
      body: { epoch: page.epoch, position },
      key: crypto.randomUUID(),
    });
  }
  /** Reopening current facts never acknowledges an uncertain confirmation. */
  async reopen(pageNumber = this.state.page?.page ?? 0) {
    const page = this.state.page;
    if (!this.current() || this.state.busy || !page) return;
    this.update({ busy: true, rejected: null });
    try {
      const result = await this.port.read(page.reviewId, pageNumber);
      if (!this.current()) return;
      if (result.kind === 'ready') {
        this.update({ page: result.value, current: {} });
        await this.readCurrent(result.value);
      } else if (result.kind === 'rejected') this.update({ rejected: result.status });
    } finally {
      this.update({ busy: false });
    }
  }
  async retry() {
    if (!this.current() || this.state.busy || !this.state.command || this.state.command.kind === 'create') return;
    await this.dispatch(this.state.command);
  }
  async cancel() {
    // Reconcile the original in-flight item before closing sender custody. No new item starts here.
    if (!this.current() || this.state.busy) return;
    if (this.state.command) await this.retry();
    const page = this.state.page;
    if (!this.current() || this.state.command || !page) return;
    await this.dispatch({
      kind: 'cancel',
      reviewId: page.reviewId,
      body: { epoch: page.epoch },
      key: crypto.randomUUID(),
    });
  }
  private async readCurrent(page: EntryAnnotationCorrectionPage) {
    const values: Record<string, PrivateEntryRead> = {};
    // Only this native four-item page is read. A stale/recreated identity cannot disclose current replacement facts.
    for (const item of page.items) {
      if (!this.current()) return;
      values[item.selected.subjectId] =
        item.current === null ? { kind: 'unavailable' } : await this.port.personal(item.selected.subjectId);
    }
    this.update({ current: values });
  }
  private async dispatch(command: CorrectionCommand) {
    this.update({ command, busy: true, uncertain: false, rejected: null });
    try {
      const result = await this.port.send(command);
      if (!this.current()) return;
      if (result.kind === 'uncertain') {
        this.update({ uncertain: true });
        return;
      }
      if (result.kind === 'rejected') {
        this.update({ command: null, rejected: result.status });
        return;
      }
      this.update({ command: null });
      if ('items' in result.value) {
        this.update({ page: result.value, current: {} });
        await Promise.all([
          this.readCurrent(result.value),
          ...(command.kind === 'confirm' ? [this.refreshEntries()] : []),
        ]);
      } else {
        this.update({ cancellation: result.value });
        const page = this.state.page!;
        const reopened = await this.port.read(page.reviewId, page.page);
        if (reopened.kind === 'ready') {
          this.update({ page: reopened.value, current: {} });
          await this.readCurrent(reopened.value);
        }
      }
    } finally {
      this.update({ busy: false });
    }
  }
}

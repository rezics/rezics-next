import type {
  BulkRead, BulkOperation, BulkOutcomes, OperationAddress, CancelCommand, CancelResult,
} from './bulk-operation-recovery-native';

export type RecoveryState = {
  read: BulkRead['state'] | 'loading';
  operation?: BulkOperation;
  page?: BulkOutcomes | undefined;
  cursor?: string | undefined;
  cancel?: CancelResult['state'] | 'sending';
};
type Access = {
  current: () => boolean;
  capture: () => () => boolean;
  csrf: () => string;
};
type Transport = {
  read: (address: OperationAddress) => Promise<BulkRead>;
  cancel: (command: CancelCommand) => Promise<CancelResult>;
};

/** Private, mounted memory only. An uncertain cancellation retains its exact command and transport. */
export class BulkOperationRecovery {
  state: RecoveryState = { read: 'loading' };
  private command?: CancelCommand;
  private send?: Transport['cancel'];
  private reading = false;
  private sending = false;
  private live = true;
  constructor(
    readonly address: Readonly<{ id: string; viewer: string }>,
    private access: Access,
    private transport: Transport,
    private changed: () => void,
  ) {}
  retire() { this.live = false; }
  private current() { return this.live && this.access.current(); }
  private publish() { if (this.current()) this.changed(); }
  async read(cursor = this.state.cursor) {
    if (!this.current() || this.reading) return;
    const current = this.access.capture();
    this.reading = true;
    this.state = { ...this.state, read: 'loading', cursor, page: undefined };
    this.publish();
    let result: BulkRead;
    try { result = await this.transport.read({ ...this.address, ...(cursor === undefined ? {} : { cursor }) }); }
    catch { result = { state: 'unavailable' }; }
    this.reading = false;
    if (!this.current() || !current()) return;
    if (result.state === 'ready' && result.operation.id !== this.address.id) result = { state: 'unavailable' };
    if (result.state === 'ready') this.state = { ...this.state, read: 'ready', operation: result.operation, page: result.page };
    else this.state = { ...this.state, read: result.state, page: undefined };
    this.publish();
  }
  more() {
    if (this.state.read === 'ready' && this.state.page?.next) return this.read(this.state.page.next);
  }
  async cancel(retry = false) {
    if (!this.current() || this.sending || !this.access.csrf()) return;
    if (retry ? this.state.cancel !== 'uncertain' : !!this.command || this.state.read !== 'ready') return;
    if (!this.command) {
      const operation = this.state.operation;
      if (!operation || operation.cancelRequested || ['completed', 'completed_with_errors', 'cancelled', 'stopped', 'expired'].includes(operation.phase)) return;
      this.command = Object.freeze({ ...this.address, key: crypto.randomUUID(), csrf: this.access.csrf() });
      this.send = this.transport.cancel;
    }
    const current = this.access.capture();
    this.sending = true;
    this.state = { ...this.state, cancel: 'sending' };
    this.publish();
    let result: CancelResult;
    try { result = await this.send!(this.command); }
    catch { result = { state: 'uncertain' }; }
    this.sending = false;
    if (!this.current() || !current()) {
      // The effect may have committed, but its late response carries no current disclosure authority.
      this.state = { ...this.state, cancel: 'uncertain' };
      return;
    }
    if (result.state === 'ready' && result.operation.id !== this.address.id) result = { state: 'uncertain' };
    this.state = { ...this.state, cancel: result.state,
      ...(result.state === 'ready' ? { operation: result.operation } : {}) };
    this.publish();
  }
}

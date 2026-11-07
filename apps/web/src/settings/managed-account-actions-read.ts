import { MediaProblem } from '../media/kernel';
import { managedAccountsException } from './managed-accounts-read';
import { withManagedReadDeadline } from './managed-read-deadline';
import type { ManagedReaderCurrent } from './managed-session-reader';
import { preferenceRetryDeadline } from './preference-failure-retry';
import { managedActionFailure as failure } from './managed-account-failure';
import type {
  ManagedAccountActionsSelection,
  ManagedAccountActionsResult,
  ManagedAccountActionsIO,
} from './managed-account-vocabulary';
export type {
  ManagedAccountActionsSelection,
  ManagedAccountActionsResult,
  ManagedAccountActionsIO,
  ManagedAccountActionsTarget,
  ManagedActionName,
  ManagedAuthNavigation,
} from './managed-account-vocabulary';
export { managedAccountActionNames } from './managed-account-vocabulary';

function exception(error: unknown): ManagedAccountActionsResult {
  const result = managedAccountsException(error);
  return failure(result.status, { code: result.code }, error instanceof MediaProblem ? error.headers : undefined);
}

type ActionsSnapshot = { result: ManagedAccountActionsResult | null; pending: boolean; retryAt: number };

/** Immutable viewer/target lifetime. Effect reattachment observes the current promise; only retry replaces failures. */
export class ManagedAccountActionsRead {
  private current?: Promise<ManagedAccountActionsResult>;
  private value: ActionsSnapshot = { result: null, pending: false, retryAt: 0 };
  private retryAt = 0;
  private disposed = false;
  private readonly lifetime = new AbortController();
  private listeners = new Set<() => void>();
  constructor(
    private readonly target: ManagedAccountActionsSelection,
    private readonly io: ManagedAccountActionsIO,
    private readonly currentOwner: ManagedReaderCurrent = () => true,
  ) {}
  snapshot = () => {
    this.live();
    return this.value;
  };
  dispose = () => {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    this.retryAt = 0;
    this.publish({ result: null, pending: false, retryAt: 0 });
  };
  isCurrent = () => this.live();
  private live() {
    if (!this.disposed && !this.currentOwner()) this.dispose();
    return !this.disposed;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(value: ActionsSnapshot) {
    this.value = value;
    for (const listener of this.listeners) listener();
  }
  load(): Promise<ManagedAccountActionsResult> {
    if (!this.live()) return Promise.resolve(failure(null));
    return this.current ?? this.request();
  }
  retry(): Promise<ManagedAccountActionsResult> {
    if (!this.live()) return Promise.resolve(failure(null));
    if (this.value.pending || this.value.result?.state !== 'unavailable' || Date.now() < this.retryAt)
      return this.load();
    return this.request();
  }
  private request(): Promise<ManagedAccountActionsResult> {
    this.current = Promise.resolve()
      .then(() =>
        this.live()
          ? withManagedReadDeadline((signal) => this.io(this.target, signal), this.lifetime.signal)
          : failure(null),
      )
      .then((result) =>
        result.state === 'ready' &&
        (result.accountId !== this.target.accountId || result.viewerId !== this.target.viewerId)
          ? failure(null)
          : result,
      )
      .catch(exception)
      .then((result) => {
        if (!this.live()) return failure(null);
        this.retryAt = result.state === 'unavailable' ? preferenceRetryDeadline(result.retryAfter) : 0;
        this.publish({ result, pending: false, retryAt: this.retryAt });
        return result;
      });
    this.publish({ ...this.value, pending: true });
    return this.current;
  }
}

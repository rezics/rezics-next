import type {
  NativePreferenceFailure,
  NotificationChange,
  NotificationPatch,
  NotificationPreferences,
  NotificationWriteResult,
  SettingsPage,
} from './preferences';
import { preferenceRetryDeadline } from './preference-failure-retry';

type Snapshot = { notifications: NotificationPreferences; version: number };
type Attempt = { input: NotificationChange; draft: NotificationPreferences };
export type NotificationEditorState = {
  known: Snapshot;
  draft: NotificationPreferences;
  pending: Attempt | null;
  /** Only deliberate choices belong to a recovery write; null retains Restore defaults. */
  intent: NotificationPatch | undefined;
  phase: 'idle' | 'saving' | 'saved' | 'uncertain' | 'conflict' | 'review' | 'reloading' | 'failed';
  /** A current read can fail independently of an earlier write or a retained review draft. */
  readOrigin: 'refresh' | 'review' | 'replay' | null;
  reason?: string | undefined;
  failure?: NativePreferenceFailure | undefined;
  retryAt: number;
};
export type NotificationEditorIO = {
  save: (input: NotificationChange) => Promise<NotificationWriteResult>;
  read: () => Promise<SettingsPage>;
  confirmed?: (version: number) => void;
};

export function sameNotifications(a: NotificationPreferences, b: NotificationPreferences): boolean {
  return Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);
}

export function notificationsNeedNavigationDecision(state: NotificationEditorState): boolean {
  return (
    state.pending !== null || state.intent !== undefined || !sameNotifications(state.known.notifications, state.draft)
  );
}

/** Keeps an unresolved command separate from edits made after it was sent. Nothing is persisted in browser storage. */
export class NotificationEditor {
  private state: NotificationEditorState;
  private listeners = new Set<() => void>();
  private versionFloor = 0;
  private disposed = false;
  dispose = () => {
    this.disposed = true;
  };
  private live = () => !this.disposed && this.isCurrent();
  constructor(
    initial: Snapshot,
    private io: NotificationEditorIO,
    initialFailed = false,
    private sharedVersion: () => number = () => initial.version,
    private isCurrent: () => boolean = () => true,
    private canWrite: () => boolean = isCurrent,
  ) {
    this.state = {
      known: { ...initial, notifications: { ...initial.notifications } },
      draft: { ...initial.notifications },
      pending: null,
      intent: undefined,
      phase: initialFailed ? 'failed' : 'idle',
      readOrigin: null,
      retryAt: 0,
    };
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<NotificationEditorState>) {
    if (!this.live()) return;
    this.state = {
      ...this.state,
      ...patch,
      // Observe delay-seconds once, without restarting or discarding the wait on local draft actions.
      ...(patch.failure ? { retryAt: preferenceRetryDeadline(patch.failure.retryAfter) } : {}),
    };
    this.listeners.forEach((listener) => listener());
  }
  private waiting() {
    return Date.now() < this.state.retryAt;
  }
  private minimumVersion(version = 0) {
    this.versionFloor = Math.max(this.versionFloor, version, this.sharedVersion(), this.state.known.version);
    return this.versionFloor;
  }
  private confirm(known: Snapshot) {
    this.update({ known });
    if (this.live()) this.io.confirmed?.(known.version);
  }
  async edit(kind: string, enabled: boolean, version: number) {
    if (!this.live() || !this.canWrite()) return;
    if (!(kind in this.state.draft)) return;
    if (this.state.intent === undefined && this.state.draft[kind] === enabled) return;
    this.minimumVersion(version);
    const local =
      this.state.pending ||
      ['conflict', 'review', 'reloading'].includes(this.state.phase) ||
      (this.state.readOrigin !== null && this.state.phase === 'failed');
    if (!local && this.waiting()) return;
    this.update({
      draft: { ...this.state.draft, [kind]: enabled },
      intent: { ...this.state.intent, [kind]: enabled },
    });
    // A refused operation still needs a current read and deliberate review.
    if (this.state.phase === 'failed') return;
    if (local) return;
    await this.start(this.state.intent!, version);
  }
  async restore(version: number) {
    if (!this.live() || !this.canWrite()) return;
    this.minimumVersion(version);
    if (
      this.state.pending ||
      this.state.phase === 'reloading' ||
      this.state.phase === 'conflict' ||
      (this.state.readOrigin !== null && this.state.phase === 'failed')
    )
      return;
    if (this.waiting()) return;
    this.update({ intent: null });
    await this.start(null, version);
  }
  async submit(version: number) {
    if (!this.live() || !this.canWrite()) return;
    this.minimumVersion(version);
    if (this.state.pending || this.state.phase !== 'review') return;
    if (this.state.intent === undefined) {
      this.useCurrent();
      return;
    }
    await this.start(this.state.intent, version);
  }
  private async start(notifications: NotificationPatch, version: number) {
    if (!this.live() || !this.canWrite()) return;
    if (this.waiting() || this.state.pending || this.state.phase === 'reloading') return;
    // Reading's version is a floor for a new read, never a baseline for these retained values.
    if (this.minimumVersion(version) > this.state.known.version) {
      this.update({ phase: 'conflict', readOrigin: null, reason: undefined, failure: undefined });
      return;
    }
    const input = Object.freeze({
      expectedVersion: this.state.known.version,
      notifications: notifications === null ? null : Object.freeze({ ...notifications }),
      idempotencyKey: crypto.randomUUID(),
    });
    this.update({ pending: { input, draft: { ...this.state.draft } }, phase: 'saving', failure: undefined });
    await this.send(false);
  }
  async retry() {
    if (!this.live() || !this.canWrite()) return;
    if (this.waiting() || !this.state.pending || this.state.phase === 'saving' || this.state.phase === 'reloading')
      return;
    await this.send(true);
  }
  private async send(recovering: boolean) {
    if (!this.live() || !this.canWrite()) return;
    const attempt = this.state.pending;
    if (!attempt) return;
    this.update({ phase: 'saving', readOrigin: null, reason: undefined, failure: undefined });
    let result: NotificationWriteResult;
    try {
      result = await this.io.save(attempt.input);
      if (!this.live() || !this.canWrite()) return;
    } catch {
      this.update({ phase: 'uncertain', reason: 'unavailable' });
      return;
    }
    if (!result.ok) {
      if (
        result.reason === 'unavailable' ||
        result.reason === 'preparing' ||
        (recovering && result.reason !== 'conflict')
      ) {
        this.update({ phase: 'uncertain', reason: result.reason, failure: result.failure });
      } else {
        this.update({
          pending: null,
          phase: result.reason === 'conflict' ? 'conflict' : 'failed',
          reason: result.reason,
          failure: result.failure,
        });
      }
      return;
    }
    if (
      !Number.isSafeInteger(result.version) ||
      result.version < Math.max(attempt.input.expectedVersion, this.state.known.version)
    ) {
      this.update({ phase: 'uncertain', reason: 'unavailable' });
      return;
    }
    const receipt = { notifications: result.notifications, version: result.version };
    if (!recovering) {
      const edited = !sameNotifications(this.state.draft, attempt.draft);
      const stale = receipt.version < this.minimumVersion();
      // This command is confirmed, but a later shared version makes its values historical.
      this.confirm(receipt);
      this.update({
        pending: null,
        draft: edited ? this.state.draft : { ...receipt.notifications },
        intent: stale || edited ? this.state.intent : undefined,
        phase: stale ? 'conflict' : edited ? 'review' : 'saved',
      });
      return;
    }
    // A replay is a historical receipt. Only an uncached native GET can establish the current values.
    this.update({ phase: 'reloading', readOrigin: 'replay' });
    const current = await this.readCurrent();
    if (!this.live()) return;
    if (!current || current.version < this.minimumVersion()) {
      this.update({ phase: 'uncertain', ...(!current ? {} : { reason: 'unavailable', failure: undefined }) });
      return;
    }
    if (
      current.version < receipt.version ||
      (current.version === receipt.version && !sameNotifications(current.notifications, receipt.notifications))
    ) {
      this.update({ phase: 'uncertain', reason: 'unavailable' });
      return;
    }
    this.confirm(current);
    const edited = !sameNotifications(this.state.draft, attempt.draft);
    const matches =
      current.version === receipt.version && sameNotifications(current.notifications, receipt.notifications);
    this.update({
      pending: null,
      draft: edited ? this.state.draft : { ...receipt.notifications },
      intent: matches && !edited ? undefined : this.state.intent,
      phase: matches && !edited ? 'saved' : 'review',
      reason: undefined,
      failure: undefined,
      readOrigin: null,
    });
  }
  private async readCurrent(): Promise<Snapshot | null> {
    if (!this.live()) return null;
    try {
      const page = await this.io.read();
      if (!this.live()) return null;
      if (
        !page.signedIn ||
        !('preferences' in page) ||
        !page.notifications ||
        !Number.isSafeInteger(page.preferences.version) ||
        page.preferences.version < this.minimumVersion()
      ) {
        this.update({
          reason: !page.signedIn
            ? 'forbidden'
            : 'failure' in page && page.failure.code === 'platform_closed'
              ? 'closed'
              : 'failure' in page && (page.failure.status === 401 || page.failure.status === 403)
                ? 'forbidden'
                : 'state' in page && page.state === 'closed'
                  ? 'closed'
                  : 'unavailable',
          failure: page.signedIn && 'failure' in page ? page.failure : undefined,
        });
        return null;
      }
      return { notifications: { ...page.notifications }, version: page.preferences.version };
    } catch {
      this.update({ reason: 'unavailable', failure: undefined });
      return null;
    }
  }
  async reload() {
    if (!this.live()) return;
    if (this.waiting() || this.state.pending || this.state.phase === 'reloading') return;
    const preserve =
      this.state.intent !== undefined ||
      !sameNotifications(this.state.draft, this.state.known.notifications) ||
      this.state.phase === 'conflict' ||
      this.state.phase === 'review' ||
      this.state.readOrigin === 'review';
    const draftAtRead = this.state.draft;
    this.update({
      phase: 'reloading',
      readOrigin: preserve ? 'review' : 'refresh',
      reason: undefined,
      failure: undefined,
    });
    const current = await this.readCurrent();
    if (!this.live()) return;
    if (!current || current.version < this.minimumVersion()) {
      this.update({ phase: 'failed', ...(!current ? {} : { reason: 'unavailable', failure: undefined }) });
      return;
    }
    const edited = preserve || this.state.draft !== draftAtRead;
    this.confirm(current);
    this.update({
      draft: edited ? this.state.draft : { ...current.notifications },
      phase: edited ? 'review' : 'idle',
      readOrigin: null,
      reason: undefined,
    });
  }
  useCurrent() {
    if (!this.live()) return;
    if (this.state.pending || this.state.readOrigin !== null) return;
    if (this.minimumVersion() > this.state.known.version) {
      this.update({ phase: 'conflict', reason: undefined, failure: undefined });
      return;
    }
    this.update({
      draft: { ...this.state.known.notifications },
      intent: undefined,
      phase: 'idle',
      reason: undefined,
      failure: undefined,
    });
  }
}

import type {
  NativePreferenceFailure,
  NotificationChange,
  NotificationPatch,
  NotificationPreferences,
  NotificationWriteResult,
  PreferencePage,
  SettingsPage,
} from './preferences';
import { optionalNotifications, preferencePageAllows } from './preferences';
import { preferenceRetryDeadline } from './preference-failure-retry';

type Snapshot = { notifications: NotificationPreferences; version: number; page: PreferencePage };
type Attempt = Readonly<{
  input: NotificationChange;
  draft: Readonly<NotificationPreferences>;
  intent: NotificationPatch | undefined;
}>;
type ConfirmedReceipt = Readonly<{ attempt: Attempt; receipt: Snapshot }>;
type ReadOrigin = 'refresh' | 'review' | 'replay' | 'reacquire';
export type NotificationEditorState = {
  known: Snapshot;
  /** Advice is usable only while it belongs to a confirmed current read or same-envelope write result. */
  currentAdvice: PreferencePage | null;
  draft: NotificationPreferences;
  pending: Attempt | null;
  /** A replay receipt proves command completion, but grants no authority until a current read succeeds. */
  confirmedReceipt: ConfirmedReceipt | null;
  /** Only deliberate choices belong to a recovery write; null retains Restore defaults. */
  intent: NotificationPatch | undefined;
  phase: 'idle' | 'saving' | 'saved' | 'uncertain' | 'conflict' | 'review' | 'reloading' | 'failed';
  /** A current read can fail independently of an earlier write or a retained review draft. */
  readOrigin: ReadOrigin | null;
  readReason?: string | undefined;
  readFailure?: NativePreferenceFailure | undefined;
  readRetryAt: number;
  commandReason?: string | undefined;
  commandFailure?: NativePreferenceFailure | undefined;
  commandRetryAt: number;
};
export type NotificationEditorIO = {
  save: (input: NotificationChange) => Promise<NotificationWriteResult>;
  read: () => Promise<SettingsPage>;
  confirmed?: (version: number) => void;
};

export function sameNotifications(a: NotificationPreferences, b: NotificationPreferences): boolean {
  return Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);
}

function intentSince(
  before: NotificationPatch | undefined,
  after: NotificationPatch | undefined,
): NotificationPatch | undefined {
  if (after === undefined || (after === null && before === null)) return undefined;
  if (after === null) return null;
  const previous = before !== undefined && before !== null ? before : {};
  const later = Object.fromEntries(Object.entries(after).filter(([kind, enabled]) => previous[kind] !== enabled));
  return Object.keys(later).length ? later : undefined;
}

export function admittedOptionalKind(page: PreferencePage, kind: string): boolean {
  return page.kinds.some((entry) => entry.kind === kind && entry.optional);
}

/** Keep only kinds the current page still admits; a removed or compulsory kind is never replayed as a new edit. */
export function admittedNotificationPatch(
  intent: NotificationPatch | undefined,
  page: PreferencePage,
): NotificationPatch | undefined {
  if (intent === undefined) return undefined;
  if (intent === null) return preferencePageAllows(page, 'reset') ? null : undefined;
  const next = Object.fromEntries(
    Object.entries(intent).filter(
      (entry): entry is [string, boolean] => admittedOptionalKind(page, entry[0]) && typeof entry[1] === 'boolean',
    ),
  );
  return Object.keys(next).length > 0 ? next : undefined;
}

export function notificationOriginalAllowed(
  input: Pick<NotificationChange, 'notifications'> | null,
  page: PreferencePage | null,
): boolean {
  if (!input || !page) return false;
  const patch = input.notifications;
  if (patch === null) return preferencePageAllows(page, 'reset');
  if (!preferencePageAllows(page, 'edit')) return false;
  const admitted = admittedNotificationPatch(patch, page);
  return (
    admitted !== undefined &&
    admitted !== null &&
    Object.keys(admitted).length === Object.keys(patch).length &&
    Object.entries(admitted).every(([kind, enabled]) => patch[kind] === enabled)
  );
}

function snapshotFrom(page: PreferencePage): Snapshot {
  return { notifications: optionalNotifications(page), version: page.version, page };
}

export function notificationsNeedNavigationDecision(state: NotificationEditorState): boolean {
  return (
    state.confirmedReceipt !== null ||
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
    if (this.disposed) return;
    this.disposed = true;
    this.state = {
      known: { notifications: {}, version: 0, page: { version: 0, kinds: [], actions: [] } },
      currentAdvice: null,
      draft: {},
      pending: null,
      confirmedReceipt: null,
      intent: undefined,
      phase: 'failed',
      readOrigin: null,
      readRetryAt: 0,
      commandRetryAt: 0,
    };
    const listeners = [...this.listeners];
    this.listeners.clear();
    listeners.forEach((listener) => listener());
  };
  private live = () => {
    if (this.disposed) return false;
    if (this.isCurrent()) return true;
    this.dispose();
    return false;
  };
  constructor(
    initial: PreferencePage,
    private io: NotificationEditorIO,
    initialFailed = false,
    private sharedVersion: () => number = () => initial.version,
    private isCurrent: () => boolean = () => true,
    private canWrite: () => boolean = isCurrent,
  ) {
    const known = snapshotFrom(initial);
    this.state = {
      known,
      currentAdvice: initialFailed ? null : initial,
      draft: { ...known.notifications },
      pending: null,
      confirmedReceipt: null,
      intent: undefined,
      phase: initialFailed ? 'failed' : 'idle',
      readOrigin: null,
      readRetryAt: 0,
      commandRetryAt: 0,
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
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private waitingForCommand() {
    return Date.now() < this.state.commandRetryAt;
  }
  private waitingForRead() {
    return Date.now() < this.state.readRetryAt;
  }
  private minimumVersion(version = 0) {
    this.versionFloor = Math.max(this.versionFloor, version, this.sharedVersion(), this.state.known.version);
    return this.versionFloor;
  }
  private confirm(known: Snapshot) {
    this.update({ known, currentAdvice: known.page, confirmedReceipt: null });
    if (this.live()) this.io.confirmed?.(known.version);
  }
  private adoptPage(page: PreferencePage, preserveDraft: boolean, phase: NotificationEditorState['phase']) {
    const known = snapshotFrom(page);
    const draft = preserveDraft
      ? Object.fromEntries(
          Object.entries(known.notifications).map(([kind, enabled]) => [
            kind,
            kind in this.state.draft ? this.state.draft[kind]! : enabled,
          ]),
        )
      : { ...known.notifications };
    const intent = preserveDraft ? admittedNotificationPatch(this.state.intent, page) : undefined;
    const edited = intent !== undefined || !sameNotifications(draft, known.notifications);
    this.confirm(known);
    this.update({
      currentAdvice: page,
      pending: null,
      draft,
      intent,
      phase: edited ? 'review' : phase === 'conflict' ? 'idle' : phase,
      readReason: undefined,
      readFailure: undefined,
      readRetryAt: 0,
      commandReason: undefined,
      commandFailure: undefined,
      commandRetryAt: 0,
      readOrigin: null,
    });
  }
  private reviewPending(page: PreferencePage) {
    const known = snapshotFrom(page);
    const draft = Object.fromEntries(
      Object.entries(known.notifications).map(([kind, enabled]) => [
        kind,
        kind in this.state.draft ? this.state.draft[kind]! : enabled,
      ]),
    );
    const intent = admittedNotificationPatch(this.state.intent, page);
    this.confirm(known);
    this.update({
      currentAdvice: page,
      draft,
      intent,
      phase: 'review',
      readOrigin: null,
      readReason: undefined,
      readFailure: undefined,
      readRetryAt: 0,
    });
  }
  private reviewConfirmed(page: PreferencePage, confirmation: ConfirmedReceipt) {
    const known = snapshotFrom(page);
    const laterIntent = intentSince(confirmation.attempt.intent, this.state.intent);
    const intent = admittedNotificationPatch(laterIntent, page);
    const draft = { ...known.notifications, ...(intent && intent !== null ? intent : {}) };
    const newer = known.version > confirmation.receipt.version;
    this.confirm(known);
    this.update({
      confirmedReceipt: null,
      pending: null,
      draft,
      intent,
      phase: newer || intent !== undefined ? 'review' : 'saved',
      readOrigin: null,
      readReason: undefined,
      readFailure: undefined,
      readRetryAt: 0,
      commandReason: undefined,
      commandFailure: undefined,
      commandRetryAt: 0,
    });
  }
  async edit(kind: string, enabled: boolean, version: number) {
    if (!this.live() || !this.canWrite()) return;
    const page = this.state.currentAdvice ?? this.state.known.page;
    if (!admittedOptionalKind(page, kind)) return;
    if (!(kind in this.state.draft)) return;
    if (this.state.intent === undefined && this.state.draft[kind] === enabled) return;
    this.minimumVersion(version);
    const local =
      this.state.pending ||
      !this.state.currentAdvice ||
      ['conflict', 'review', 'reloading'].includes(this.state.phase) ||
      (this.state.readOrigin !== null && this.state.phase === 'failed');
    if (!local && (!preferencePageAllows(page, 'edit') || this.waitingForCommand())) return;
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
    const page = this.state.currentAdvice;
    if (!page || !preferencePageAllows(page, 'reset')) return;
    this.minimumVersion(version);
    if (
      this.state.pending ||
      this.state.phase === 'reloading' ||
      this.state.phase === 'conflict' ||
      (this.state.readOrigin !== null && this.state.phase === 'failed')
    )
      return;
    if (this.waitingForCommand()) return;
    this.update({ intent: null });
    await this.start(null, version);
  }
  async submit(version: number) {
    if (!this.live() || !this.canWrite()) return;
    this.minimumVersion(version);
    if (this.state.pending || this.state.phase !== 'review' || this.waitingForCommand() || !this.state.currentAdvice)
      return;
    if (this.state.intent === undefined) {
      this.useCurrent();
      return;
    }
    await this.start(this.state.intent, version);
  }
  private async start(notifications: NotificationPatch, version: number) {
    if (!this.live() || !this.canWrite()) return;
    if (this.waitingForCommand() || this.state.pending || this.state.phase === 'reloading') return;
    const page = this.state.currentAdvice;
    if (!page) return;
    // Reading's version is a floor for a new read, never a baseline for these retained values.
    if (this.minimumVersion(version) > this.state.known.version) {
      this.update({
        phase: 'conflict',
        readOrigin: null,
        readReason: undefined,
        readFailure: undefined,
        commandReason: undefined,
        commandFailure: undefined,
      });
      return;
    }
    const admitted = admittedNotificationPatch(notifications, page);
    if (admitted === undefined) return;
    if (!preferencePageAllows(page, admitted === null ? 'reset' : 'edit')) return;
    const input = Object.freeze({
      expectedVersion: this.state.known.version,
      notifications: admitted === null ? null : Object.freeze({ ...admitted }),
      idempotencyKey: crypto.randomUUID(),
    });
    const intent =
      this.state.intent === null
        ? null
        : this.state.intent === undefined
          ? undefined
          : Object.freeze({ ...this.state.intent });
    this.update({
      pending: Object.freeze({ input, draft: Object.freeze({ ...this.state.draft }), intent }),
      phase: 'saving',
      commandReason: undefined,
      commandFailure: undefined,
    });
    await this.send(false);
  }
  async retry() {
    if (!this.live() || !this.canWrite()) return;
    const page = this.state.currentAdvice;
    if (
      this.waitingForCommand() ||
      !this.state.pending ||
      (this.state.phase !== 'uncertain' && this.state.phase !== 'review') ||
      !page ||
      !notificationOriginalAllowed(this.state.pending.input, page)
    )
      return;
    await this.send(true);
  }
  private async send(recovering: boolean) {
    if (!this.live() || !this.canWrite()) return;
    const attempt = this.state.pending;
    if (!attempt) return;
    this.update({
      phase: 'saving',
      readOrigin: null,
      commandReason: undefined,
      commandFailure: undefined,
    });
    let result: NotificationWriteResult;
    try {
      result = await this.io.save(attempt.input);
      if (!this.live() || !this.canWrite()) return;
    } catch {
      this.update({ phase: 'uncertain', commandReason: 'unavailable', commandFailure: undefined });
      return;
    }
    if (!result.ok) {
      if (result.reason === 'conflict' && result.page) {
        this.adoptPage(result.page, true, 'conflict');
        return;
      }
      const retireAdvice = result.reason === 'forbidden' || result.reason === 'closed' || result.reason === 'conflict';
      const command = {
        commandReason: result.reason,
        commandFailure: result.failure,
        commandRetryAt: preferenceRetryDeadline(result.failure?.retryAfter),
        ...(retireAdvice ? { currentAdvice: null } : {}),
      };
      if (
        result.reason === 'unavailable' ||
        result.reason === 'preparing' ||
        (recovering && result.reason !== 'conflict')
      ) {
        this.update({ ...command, phase: 'uncertain' });
      } else {
        this.update({
          ...command,
          pending: null,
          phase: result.reason === 'conflict' ? 'conflict' : 'failed',
        });
      }
      return;
    }
    if (
      !Number.isSafeInteger(result.version) ||
      result.version < Math.max(attempt.input.expectedVersion, this.state.known.version)
    ) {
      this.update({ phase: 'uncertain', commandReason: 'unavailable', commandFailure: undefined });
      return;
    }
    const receipt = snapshotFrom(result.page);
    if (!recovering) {
      const edited = !sameNotifications(this.state.draft, attempt.draft);
      const stale = receipt.version < this.minimumVersion();
      // This command is confirmed, but a later shared version makes its values historical.
      this.confirm(receipt);
      const draft = Object.fromEntries(
        Object.entries(receipt.notifications).map(([kind, enabled]) => [
          kind,
          edited && kind in this.state.draft ? this.state.draft[kind]! : enabled,
        ]),
      );
      this.update({
        pending: null,
        draft,
        intent: stale || edited ? admittedNotificationPatch(this.state.intent, receipt.page) : undefined,
        phase: stale ? 'conflict' : edited ? 'review' : 'saved',
        readOrigin: null,
        readReason: undefined,
        readFailure: undefined,
        readRetryAt: 0,
        commandReason: undefined,
        commandFailure: undefined,
        commandRetryAt: 0,
      });
      return;
    }
    // A replay receipt completes the command, but only an uncached native GET establishes current values.
    const confirmation = Object.freeze({ attempt, receipt });
    this.minimumVersion(receipt.version);
    this.update({
      confirmedReceipt: confirmation,
      pending: null,
      phase: 'reloading',
      readOrigin: 'replay',
      commandReason: undefined,
      commandFailure: undefined,
      commandRetryAt: 0,
    });
    const current = await this.readCurrent();
    if (!this.live()) return;
    if (!current || current.version < this.minimumVersion()) {
      this.update({ phase: 'failed', ...(!current ? {} : { currentAdvice: null, readReason: 'unavailable', readFailure: undefined }) });
      return;
    }
    if (
      current.version < receipt.version ||
      (current.version === receipt.version && !sameNotifications(current.notifications, receipt.notifications))
    ) {
      this.update({
        phase: 'failed',
        currentAdvice: null,
        readReason: 'unavailable',
        readFailure: undefined,
        readRetryAt: 0,
      });
      return;
    }
    this.reviewConfirmed(current.page, confirmation);
  }
  private async readCurrent(): Promise<Snapshot | null> {
    if (!this.live()) return null;
    this.update({ currentAdvice: null, readReason: undefined, readFailure: undefined });
    try {
      const page = await this.io.read();
      if (!this.live()) return null;
      if (
        !page.signedIn ||
        !('preferences' in page) ||
        !page.page ||
        !page.notifications ||
        !Number.isSafeInteger(page.preferences.version) ||
        page.preferences.version < this.minimumVersion()
      ) {
        this.update({
          readReason: !page.signedIn
            ? 'forbidden'
            : 'failure' in page && page.failure.code === 'platform_closed'
              ? 'closed'
              : 'failure' in page && (page.failure.status === 401 || page.failure.status === 403)
                ? 'forbidden'
                : 'state' in page && page.state === 'closed'
                  ? 'closed'
                  : 'unavailable',
          readFailure: page.signedIn && 'failure' in page ? page.failure : undefined,
          readRetryAt: preferenceRetryDeadline(
            page.signedIn && 'failure' in page ? page.failure.retryAfter : undefined,
          ),
        });
        return null;
      }
      return snapshotFrom(page.page);
    } catch {
      this.update({ readReason: 'unavailable', readFailure: undefined, readRetryAt: 0 });
      return null;
    }
  }
  async reload() {
    if (!this.live()) return;
    if (this.waitingForRead() || this.state.phase === 'saving' || this.state.phase === 'reloading') return;
    const pending = this.state.pending;
    const confirmation = this.state.confirmedReceipt;
    const preserve =
      pending !== null ||
      confirmation !== null ||
      this.state.intent !== undefined ||
      !sameNotifications(this.state.draft, this.state.known.notifications) ||
      this.state.phase === 'conflict' ||
      this.state.phase === 'review' ||
      this.state.readOrigin === 'review';
    const draftAtRead = this.state.draft;
    this.update({
      phase: 'reloading',
      readOrigin: pending ? 'reacquire' : confirmation ? 'replay' : preserve ? 'review' : 'refresh',
      readReason: undefined,
      readFailure: undefined,
    });
    const current = await this.readCurrent();
    if (!this.live()) return;
    if (!current || current.version < this.minimumVersion()) {
      this.update({
        phase: pending ? 'uncertain' : 'failed',
        ...(!current ? {} : { currentAdvice: null, readReason: 'unavailable', readFailure: undefined }),
      });
      return;
    }
    if (pending) {
      this.reviewPending(current.page);
      return;
    }
    if (confirmation) {
      if (
        current.version < confirmation.receipt.version ||
        (current.version === confirmation.receipt.version &&
          !sameNotifications(current.notifications, confirmation.receipt.notifications))
      ) {
        this.update({
          phase: 'failed',
          currentAdvice: null,
          readReason: 'unavailable',
          readFailure: undefined,
          readRetryAt: 0,
        });
        return;
      }
      this.reviewConfirmed(current.page, confirmation);
      return;
    }
    this.adoptPage(current.page, preserve || this.state.draft !== draftAtRead, 'idle');
  }
  useCurrent() {
    if (!this.live()) return;
    if (this.state.pending || this.state.readOrigin !== null || !this.state.currentAdvice) return;
    if (this.minimumVersion() > this.state.known.version) {
      this.update({ phase: 'conflict', readReason: undefined, readFailure: undefined });
      return;
    }
    this.update({
      draft: { ...this.state.known.notifications },
      intent: undefined,
      phase: 'idle',
      readReason: undefined,
      readFailure: undefined,
      commandReason: undefined,
      commandFailure: undefined,
    });
  }
}

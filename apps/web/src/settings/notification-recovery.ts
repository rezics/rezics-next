import type {
  NativePreferenceFailure,
  NotificationChange,
  NotificationPatch,
  NotificationPreferences,
  NotificationWriteResult,
  SettingsPage,
} from './preferences';

type Snapshot = { notifications: NotificationPreferences; version: number };
type Attempt = { input: NotificationChange; draft: NotificationPreferences };
export type NotificationEditorState = {
  known: Snapshot;
  draft: NotificationPreferences;
  pending: Attempt | null;
  phase: 'idle' | 'saving' | 'saved' | 'uncertain' | 'conflict' | 'review' | 'reloading' | 'failed';
  failure?: NativePreferenceFailure;
};
export type NotificationEditorIO = {
  save: (input: NotificationChange) => Promise<NotificationWriteResult>;
  read: () => Promise<SettingsPage>;
  confirmed?: (version: number) => void;
};

export function sameNotifications(a: NotificationPreferences, b: NotificationPreferences): boolean {
  return Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);
}

/** Keeps an unresolved command separate from edits made after it was sent. Nothing is persisted in browser storage. */
export class NotificationEditor {
  private state: NotificationEditorState;
  private listeners = new Set<() => void>();
  constructor(
    initial: Snapshot,
    private io: NotificationEditorIO,
    initialFailed = false,
  ) {
    this.state = {
      known: { ...initial, notifications: { ...initial.notifications } },
      draft: { ...initial.notifications },
      pending: null,
      phase: initialFailed ? 'failed' : 'idle',
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
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private confirm(known: Snapshot) {
    this.update({ known });
    this.io.confirmed?.(known.version);
  }
  async edit(kind: string, enabled: boolean, version: number) {
    this.update({ draft: { ...this.state.draft, [kind]: enabled } });
    if (this.state.pending || ['conflict', 'review', 'reloading'].includes(this.state.phase)) return;
    await this.start({ [kind]: enabled }, version);
  }
  async restore(version: number) {
    if (this.state.pending || this.state.phase === 'reloading' || this.state.phase === 'conflict') return;
    await this.start(null, version);
  }
  async submit(version: number) {
    if (this.state.pending || this.state.phase !== 'review') return;
    await this.start({ ...this.state.draft }, version);
  }
  private async start(notifications: NotificationPatch, version: number) {
    const input = Object.freeze({
      expectedVersion: version,
      notifications: notifications === null ? null : Object.freeze({ ...notifications }),
      idempotencyKey: crypto.randomUUID(),
    });
    this.update({ pending: { input, draft: { ...this.state.draft } }, phase: 'saving', failure: undefined });
    await this.send(false);
  }
  async retry() {
    if (!this.state.pending || this.state.phase === 'saving' || this.state.phase === 'reloading') return;
    await this.send(true);
  }
  private async send(recovering: boolean) {
    const attempt = this.state.pending;
    if (!attempt) return;
    this.update({ phase: 'saving', failure: undefined });
    let result: NotificationWriteResult;
    try {
      result = await this.io.save(attempt.input);
    } catch {
      this.update({ phase: 'uncertain' });
      return;
    }
    if (!result.ok) {
      if (result.reason === 'unavailable' || result.reason === 'preparing') {
        this.update({ phase: 'uncertain', failure: result.failure });
      } else {
        this.update({
          pending: null,
          phase: result.reason === 'conflict' ? 'conflict' : 'failed',
          draft: result.reason === 'conflict' ? this.state.draft : { ...this.state.known.notifications },
          failure: result.failure,
        });
      }
      return;
    }
    if (!Number.isSafeInteger(result.version) || result.version < attempt.input.expectedVersion) {
      this.update({ phase: 'uncertain' });
      return;
    }
    const receipt = { notifications: result.notifications, version: result.version };
    const edited = !sameNotifications(this.state.draft, attempt.draft);
    if (!recovering) {
      this.confirm(receipt);
      this.update({
        pending: null,
        draft: edited ? this.state.draft : { ...receipt.notifications },
        phase: edited ? 'review' : 'saved',
      });
      return;
    }
    // A replay is a historical receipt. Only an uncached native GET can establish the current values.
    this.update({ phase: 'reloading' });
    const current = await this.readCurrent();
    if (!current) {
      this.update({ phase: 'uncertain' });
      return;
    }
    if (
      current.version < receipt.version ||
      (current.version === receipt.version && !sameNotifications(current.notifications, receipt.notifications))
    ) {
      this.update({ phase: 'uncertain' });
      return;
    }
    this.confirm(current);
    const matches =
      current.version === receipt.version && sameNotifications(current.notifications, receipt.notifications);
    this.update({
      pending: null,
      draft: edited ? this.state.draft : { ...receipt.notifications },
      phase: matches && !edited ? 'saved' : 'review',
      failure: undefined,
    });
  }
  private async readCurrent(): Promise<Snapshot | null> {
    try {
      const page = await this.io.read();
      if (
        !page.signedIn ||
        !('preferences' in page) ||
        !page.notifications ||
        !Number.isSafeInteger(page.preferences.version) ||
        page.preferences.version < 0
      ) {
        this.update({ failure: page.signedIn && 'failure' in page ? page.failure : undefined });
        return null;
      }
      return { notifications: { ...page.notifications }, version: page.preferences.version };
    } catch {
      this.update({ failure: undefined });
      return null;
    }
  }
  async reload() {
    if (this.state.pending || this.state.phase === 'reloading') return;
    const preserve =
      !sameNotifications(this.state.draft, this.state.known.notifications) || this.state.phase === 'conflict';
    this.update({ phase: 'reloading', failure: undefined });
    const current = await this.readCurrent();
    if (!current) {
      this.update({ phase: 'failed' });
      return;
    }
    this.confirm(current);
    this.update({
      draft: preserve ? this.state.draft : { ...current.notifications },
      phase: preserve ? 'review' : 'idle',
    });
  }
  useCurrent() {
    if (this.state.pending || this.state.phase === 'reloading') return;
    this.update({ draft: { ...this.state.known.notifications }, phase: 'idle', failure: undefined });
  }
}

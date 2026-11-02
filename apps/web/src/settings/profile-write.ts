import { withProfileDeadline } from './profile-request-deadline';
import {
  profileChanges,
  profileReadDenied,
  type ProfilePatch,
  type ProfileSaveResult,
  type ProfileValues,
} from './profile-data';
import { profileReadFailure, type EditableProfileFailure } from './editable-profile-source';
import { isPlatformClosedError } from '../kernel/platform-closed';

export type ProfileScope = 'profile' | 'views';
export type ProfileAttempt = Readonly<{
  before: ProfileValues;
  patch: ProfilePatch;
  after: ProfileValues;
  idempotencyKey: string;
  scope: ProfileScope;
}>;
export type ProfileEditorIO = {
  read: (signal?: AbortSignal) => Promise<ProfileValues>;
  save: (attempt: ProfileAttempt, signal?: AbortSignal) => Promise<ProfileSaveResult>;
  confirmed?: (profile: ProfileValues) => void;
  isCurrent?: () => boolean;
  canWrite?: () => boolean;
};
export type ProfileEditorState = {
  known: ProfileValues | null;
  draft: ProfileValues | null;
  attempt: ProfileAttempt | null;
  phase: 'loading' | 'idle' | 'saving' | 'reloading' | 'saved' | 'uncertain' | 'refused' | 'review' | 'unavailable';
  scope: ProfileScope;
  readAuthority: 'pending' | 'allowed' | 'denied';
  /** Presentation only: current reads are shared by both callers, independently of the last command's scope. */
  readStatus?: 'checking' | 'confirming' | 'failed' | undefined;
  failure?: (EditableProfileFailure & { message: string }) | undefined;
};

function failureMetadata(error: unknown): EditableProfileFailure | undefined {
  return (
    profileReadFailure(error) ?? (isPlatformClosedError(error) ? { status: 403, code: 'platform_closed' } : undefined)
  );
}

function frozen<T extends object>(value: T): T {
  Object.values(value).forEach((part) => {
    if (part && typeof part === 'object') frozen(part);
  });
  return Object.freeze(value);
}

/** Apply only edits made since base, including individual merge-patch view flags. */
export function rebaseProfile(base: ProfileValues, draft: ProfileValues, current: ProfileValues): ProfileValues {
  const patch = profileChanges(base, draft);
  return {
    ...current,
    ...(patch.displayName !== undefined ? { displayName: draft.displayName } : {}),
    ...(patch.biography !== undefined ? { biography: draft.biography } : {}),
    ...(patch.avatar !== undefined ? { avatar: draft.avatar } : {}),
    ...(patch.links !== undefined ? { links: draft.links } : {}),
    publicViews: { ...current.publicViews, ...patch.publicViews },
    ...(patch.speakersListed !== undefined ? { speakersListed: patch.speakersListed } : {}),
  };
}

export function profileFieldErrors(profile: ProfileValues): Record<string, 'text' | 'label' | 'url' | 'links'> {
  const errors: ReturnType<typeof profileFieldErrors> = {};
  if ((profile.displayName?.length ?? 0) > 4096) errors.displayName = 'text';
  if ((profile.biography?.length ?? 0) > 4096) errors.biography = 'text';
  if (profile.links.length > 5) errors.links = 'links';
  profile.links.forEach((link, index) => {
    // A label must name the link; keep its exact text in the draft when validation fails.
    if (!link.label.trim() || Array.from(link.label).length > 64) errors[`label-${index}`] = 'label';
    try {
      const url = new URL(link.url);
      if (
        url.protocol !== 'https:' ||
        !url.hostname ||
        url.username ||
        url.password ||
        Array.from(link.url).length > 2048 ||
        /[\u0000-\u0020\u007f]/.test(link.url) ||
        !/^https:\/\/[^/@\s]+(?:[/?#]|$)/i.test(link.url)
      )
        errors[`url-${index}`] = 'url';
    } catch {
      errors[`url-${index}`] = 'url';
    }
  });
  return errors;
}

/** One account's profile and view controls share drafts, readback and one in-memory unresolved command. */
export class ProfileEditor {
  private state: ProfileEditorState;
  private listeners = new Set<() => void>();
  private active = true;
  private lifetime = new AbortController();
  private readVersion = 0;
  private pending = false;
  // Value comparisons alone cannot distinguish a later edit back to the original value.
  // Keep these edits across unknown outcomes and retries of the same immutable attempt.
  private laterEdits: ProfilePatch = {};
  constructor(
    private io: ProfileEditorIO,
    initial: ProfileValues | null = null,
  ) {
    this.state = {
      known: initial,
      draft: initial,
      attempt: null,
      phase: initial ? 'idle' : 'loading',
      scope: 'profile',
      readAuthority: initial ? 'allowed' : 'pending',
    };
  }
  snapshot = () => this.state;
  isActive = () => this.active;
  subscribe = (listener: () => void) => {
    if (!this.active) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<ProfileEditorState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private current() {
    if (this.active && this.io.isCurrent && !this.io.isCurrent()) this.retire();
    return this.active;
  }
  /** Keep reader access independent from the current-token gate used by commands and drafts. */
  canWrite() {
    return this.current() && (this.io.canWrite?.() ?? true);
  }
  /** End this observation lifetime; an old promise must never revive it or publish confirmed data. */
  retire() {
    if (!this.active) return;
    this.active = false;
    this.lifetime.abort();
    this.readVersion++;
    this.laterEdits = {};
    this.update({
      known: null,
      draft: null,
      attempt: null,
      phase: 'unavailable',
      readAuthority: 'pending',
      readStatus: undefined,
      failure: undefined,
    });
    this.listeners.clear();
    this.io = {
      read: async () => {
        throw new Error('Profile unavailable');
      },
      save: async () => {
        throw new Error('Profile unavailable');
      },
    };
  }
  receive(current: ProfileValues) {
    if (!this.current() || this.state.readAuthority === 'denied') return;
    const { known, draft } = this.state;
    if (known && current.accountId !== known.accountId) throw new Error('Profile account changed');
    this.update({
      known: current,
      draft: known && draft ? this.preserveLaterEdits(rebaseProfile(known, draft, current), draft) : current,
      phase: this.state.phase === 'loading' || this.state.phase === 'unavailable' ? 'idle' : this.state.phase,
      readAuthority: 'allowed',
      ...(this.state.phase === 'loading' || this.state.phase === 'unavailable' ? { readStatus: undefined } : {}),
    });
  }
  unavailable(error?: unknown) {
    if (!this.current()) return;
    const denied = profileReadDenied(error);
    const failure = failureMetadata(error);
    if (denied) this.readVersion++;
    this.update({
      phase: this.state.attempt ? 'uncertain' : 'unavailable',
      readStatus: 'failed',
      failure: failure ? { ...failure, message: '' } : undefined,
      ...(denied ? { readAuthority: 'denied' as const } : {}),
    });
  }
  edit(patch: Partial<ProfileValues>) {
    if (!this.canWrite() || !this.state.draft || this.state.readAuthority !== 'allowed') return;
    const draft = {
      ...this.state.draft,
      ...patch,
      accountId: this.state.draft.accountId,
      kind: this.state.draft.kind,
    };
    if (this.pending || this.state.attempt) {
      const changes = profileChanges(this.state.draft, draft);
      this.laterEdits = {
        ...this.laterEdits,
        ...changes,
        publicViews: { ...this.laterEdits.publicViews, ...changes.publicViews },
      };
    }
    this.update({
      draft,
      phase: this.state.phase === 'saved' ? 'idle' : this.state.phase,
    });
  }
  private preserveLaterEdits(merged: ProfileValues, draft: ProfileValues): ProfileValues {
    const edits = this.laterEdits;
    return {
      ...merged,
      ...(edits.displayName !== undefined ? { displayName: draft.displayName } : {}),
      ...(edits.biography !== undefined ? { biography: draft.biography } : {}),
      ...(edits.avatar !== undefined ? { avatar: draft.avatar } : {}),
      ...(edits.links !== undefined ? { links: draft.links } : {}),
      publicViews: { ...merged.publicViews, ...edits.publicViews },
      ...(edits.speakersListed !== undefined ? { speakersListed: draft.speakersListed } : {}),
    };
  }
  review() {
    if (!this.current() || this.state.readAuthority !== 'allowed') return;
    this.update({ phase: this.state.attempt ? 'uncertain' : 'idle' });
  }
  async submit(scope: ProfileScope) {
    if (!this.canWrite() || this.state.readAuthority !== 'allowed') return;
    const { known, draft, attempt, phase } = this.state;
    if (this.pending || !known || !draft || attempt || ['saving', 'reloading', 'unavailable'].includes(phase)) return;
    const after: ProfileValues =
      scope === 'profile'
        ? {
            ...known,
            displayName: draft.displayName,
            biography: draft.biography,
            avatar: draft.avatar,
            links: draft.links,
          }
        : {
            ...known,
            publicViews: draft.publicViews,
            ...(known.kind === 'organization' ? { speakersListed: draft.speakersListed } : {}),
          };
    if (scope === 'profile' && Object.keys(profileFieldErrors(after)).length) {
      this.update({ phase: 'review', scope });
      return;
    }
    const patch = profileChanges(known, after);
    if (!Object.keys(patch).length) return;
    const next = frozen(structuredClone({ before: known, after, patch, scope, idempotencyKey: crypto.randomUUID() }));
    this.laterEdits = {};
    this.update({ attempt: next, scope });
    await this.send(false);
  }
  async retry() {
    if (!this.canWrite() || this.pending || !this.state.attempt || ['saving', 'reloading'].includes(this.state.phase))
      return;
    await this.send(true);
  }
  private async send(recovering: boolean) {
    this.pending = true;
    try {
      await this.sendAttempt(recovering);
    } finally {
      this.pending = false;
    }
  }
  private async sendAttempt(recovering: boolean) {
    const attempt = this.state.attempt;
    if (!attempt) return;
    this.update({ phase: 'saving', readStatus: undefined, failure: undefined });
    let result: ProfileSaveResult;
    try {
      result = await withProfileDeadline((signal) => this.io.save(attempt, signal), this.lifetime.signal);
    } catch (error) {
      if (!this.current()) return;
      const failure = failureMetadata(error);
      this.update({ phase: 'uncertain', failure: failure ? { ...failure, message: '' } : undefined });
      return;
    }
    if (!this.current()) return;
    if (!result.ok) {
      const uncertain = recovering || result.status >= 500;
      this.update({
        phase: uncertain ? 'uncertain' : 'refused',
        attempt: uncertain ? attempt : null,
        failure: { ...result.failure, status: result.status, message: result.message },
      });
      return;
    }
    // A refusal of current reads is not permission to republish an earlier projection or acknowledgement.
    if (this.state.readAuthority === 'denied') {
      this.update({ phase: 'uncertain' });
      return;
    }
    // A new acknowledgement and a replay are both historical. Always read the current native profile.
    this.update({ phase: 'reloading', readStatus: 'confirming' });
    const version = this.readVersion;
    try {
      const current = await withProfileDeadline((signal) => this.io.read(signal), this.lifetime.signal);
      if (!this.current() || version !== this.readVersion) return;
      this.finishRead(current, true);
    } catch (error) {
      if (this.current() && version === this.readVersion) this.unavailable(error);
    }
  }
  private finishRead(current: ProfileValues, acknowledged: boolean) {
    const { attempt, known, draft } = this.state;
    if (known && known.accountId !== current.accountId) throw new Error('Profile account changed');
    if (!draft) {
      this.update({
        known: current,
        draft: current,
        phase: 'idle',
        readAuthority: 'allowed',
        readStatus: undefined,
        failure: undefined,
      });
    } else if (attempt) {
      // Compare only the command's fields: unrelated current changes must not invalidate confirmation.
      const confirmed =
        Object.keys(profileChanges(current, rebaseProfile(attempt.before, attempt.after, current))).length === 0;
      const nextDraft = this.preserveLaterEdits(
        rebaseProfile(confirmed ? attempt.after : attempt.before, draft, current),
        draft,
      );
      const resolved = acknowledged || confirmed;
      this.update({
        known: current,
        draft: nextDraft,
        attempt: resolved ? null : attempt,
        phase: !resolved
          ? 'uncertain'
          : confirmed && !Object.keys(profileChanges(current, nextDraft)).length
            ? 'saved'
            : 'review',
        failure: undefined,
        readAuthority: 'allowed',
        readStatus: undefined,
      });
    } else {
      const nextDraft = this.preserveLaterEdits(known ? rebaseProfile(known, draft, current) : current, draft);
      this.update({
        known: current,
        draft: nextDraft,
        phase: Object.keys(profileChanges(current, nextDraft)).length ? 'review' : 'idle',
        failure: undefined,
        readAuthority: 'allowed',
        readStatus: undefined,
      });
    }
    if (!this.state.attempt) this.laterEdits = {};
    if (this.current() && this.state.readAuthority === 'allowed') this.io.confirmed?.(current);
  }
  async reload() {
    if (!this.current() || this.pending || ['saving', 'reloading'].includes(this.state.phase)) return;
    if (!this.state.attempt) this.laterEdits = {};
    this.pending = true;
    this.update({ phase: 'reloading', readStatus: 'checking', failure: undefined });
    const version = this.readVersion;
    try {
      const current = await withProfileDeadline((signal) => this.io.read(signal), this.lifetime.signal);
      if (!this.current() || version !== this.readVersion) return;
      this.finishRead(current, false);
    } catch (error) {
      if (this.current() && version === this.readVersion) this.unavailable(error);
    } finally {
      this.pending = false;
    }
  }
}

type ProfileSession = { state: string; subject?: string | null; csrfToken: string | null };
type ProfileActor = { subject: string; incarnation: string };
type ProfileReader = { subject: string; csrfToken: string | null };
function profileReader(session: ProfileSession | undefined): ProfileReader | null {
  return session?.state === 'signed-in' && session.subject
    ? { subject: session.subject, csrfToken: session.csrfToken }
    : null;
}
function profileActor(session: ProfileSession | undefined): ProfileActor | null {
  return session?.state === 'signed-in' && session.subject && session.csrfToken
    ? { subject: session.subject, incarnation: session.csrfToken }
    : null;
}

/** Exactly one observation, with no history to reuse after an interrupted or replaced session. */
export class ProfileEditorSession {
  readonly reader: ProfileReader | null;
  readonly actor: ProfileActor | null;
  readonly key: readonly ['settings', 'profile', string | null, string | null, string];
  readonly editor: ProfileEditor;
  private readonly observedState: string;
  private readonly observedSubject: string | null | undefined;
  private readonly observedCsrfToken: string | null;
  private active = true;
  constructor(session: ProfileSession, createIO: (owner: ProfileEditorSession) => ProfileEditorIO) {
    this.observedState = session.state;
    this.observedSubject = session.subject;
    this.observedCsrfToken = session.csrfToken;
    this.reader = profileReader(session);
    this.actor = profileActor(session);
    // Keep the original CSRF identity in memory for writes; never put it in a query key.
    this.key = ['settings', 'profile', this.reader?.subject ?? null, null, crypto.randomUUID()];
    const io = createIO(this);
    this.editor = new ProfileEditor({
      ...io,
      read: async (signal) => {
        if (!this.canRead()) throw new Error('Profile unavailable');
        return io.read(signal);
      },
      isCurrent: () => this.isActive() && (io.isCurrent?.() ?? true),
      canWrite: () => this.canWrite() && (io.canWrite?.() ?? true),
    });
    if (!this.reader) this.editor.unavailable();
  }
  matches(session: ProfileSession | undefined) {
    return (
      this.active &&
      this.editor.isActive() &&
      this.observedState === session?.state &&
      this.observedSubject === session?.subject &&
      this.observedCsrfToken === session?.csrfToken
    );
  }
  isCurrent = () => this.active && !!this.reader && this.editor.isActive();
  canRead = () => this.active && !!this.reader && this.editor.isActive();
  canWrite = () => this.active && !!this.actor && this.editor.isActive();
  private isActive = () => this.active && this.editor.isActive();
  retire() {
    this.active = false;
    this.editor.retire();
  }
}

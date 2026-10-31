import {
  profileChanges,
  profileReadDenied,
  type ProfilePatch,
  type ProfileSaveResult,
  type ProfileValues,
} from './profile-data';
import { profileReadFailure, type EditableProfileFailure } from './editable-profile-source';

export type ProfileScope = 'profile' | 'views';
export type ProfileAttempt = Readonly<{
  before: ProfileValues;
  patch: ProfilePatch;
  after: ProfileValues;
  idempotencyKey: string;
  scope: ProfileScope;
}>;
export type ProfileEditorIO = {
  read: () => Promise<ProfileValues>;
  save: (attempt: ProfileAttempt) => Promise<ProfileSaveResult>;
  confirmed?: (profile: ProfileValues) => void;
  isCurrent?: () => boolean;
};
export type ProfileEditorState = {
  known: ProfileValues | null;
  draft: ProfileValues | null;
  attempt: ProfileAttempt | null;
  phase: 'loading' | 'idle' | 'saving' | 'reloading' | 'saved' | 'uncertain' | 'refused' | 'review' | 'unavailable';
  scope: ProfileScope;
  readAuthority: 'pending' | 'allowed' | 'denied';
  failure?: (EditableProfileFailure & { message: string }) | undefined;
};

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
    if (!link.label.length || Array.from(link.label).length > 64) errors[`label-${index}`] = 'label';
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
  private readVersion = 0;
  private pending = false;
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
  /** End this observation lifetime; an old promise must never revive it or publish confirmed data. */
  retire() {
    if (!this.active) return;
    this.active = false;
    this.readVersion++;
    this.update({
      known: null,
      draft: null,
      attempt: null,
      phase: 'unavailable',
      readAuthority: 'pending',
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
      draft: known && draft ? rebaseProfile(known, draft, current) : current,
      phase: this.state.phase === 'loading' || this.state.phase === 'unavailable' ? 'idle' : this.state.phase,
      readAuthority: 'allowed',
    });
  }
  unavailable(error?: unknown) {
    if (!this.current()) return;
    const denied = profileReadDenied(error);
    const failure = profileReadFailure(error);
    if (denied) this.readVersion++;
    this.update({
      phase: this.state.attempt ? 'uncertain' : 'unavailable',
      failure: failure ? { ...failure, message: '' } : undefined,
      ...(denied ? { readAuthority: 'denied' as const } : {}),
    });
  }
  edit(patch: Partial<ProfileValues>) {
    if (!this.current() || !this.state.draft || this.state.readAuthority !== 'allowed') return;
    this.update({
      draft: { ...this.state.draft, ...patch },
      phase: this.state.phase === 'saved' ? 'idle' : this.state.phase,
    });
  }
  review() {
    if (!this.current() || this.state.readAuthority !== 'allowed') return;
    this.update({ phase: this.state.attempt ? 'uncertain' : 'idle' });
  }
  async submit(scope: ProfileScope) {
    if (!this.current() || this.state.readAuthority !== 'allowed') return;
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
    this.update({ attempt: next, scope });
    await this.send(false);
  }
  async retry() {
    if (!this.current() || this.pending || !this.state.attempt || ['saving', 'reloading'].includes(this.state.phase))
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
    this.update({ phase: 'saving', failure: undefined });
    let result: ProfileSaveResult;
    try {
      result = await this.io.save(attempt);
    } catch (error) {
      if (!this.current()) return;
      const failure = profileReadFailure(error);
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
    this.update({ phase: 'reloading' });
    const version = this.readVersion;
    try {
      const current = await this.io.read();
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
      this.update({ known: current, draft: current, phase: 'idle', readAuthority: 'allowed', failure: undefined });
    } else if (attempt) {
      // Compare only the command's fields: unrelated current changes must not invalidate confirmation.
      const confirmed =
        Object.keys(profileChanges(current, rebaseProfile(attempt.before, attempt.after, current))).length === 0;
      const nextDraft = rebaseProfile(confirmed ? attempt.after : attempt.before, draft, current);
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
      });
    } else {
      const nextDraft = known ? rebaseProfile(known, draft, current) : current;
      this.update({
        known: current,
        draft: nextDraft,
        phase: Object.keys(profileChanges(current, nextDraft)).length ? 'review' : 'idle',
        failure: undefined,
        readAuthority: 'allowed',
      });
    }
    if (this.current() && this.state.readAuthority === 'allowed') this.io.confirmed?.(current);
  }
  async reload() {
    if (!this.current() || this.pending || ['saving', 'reloading'].includes(this.state.phase)) return;
    this.pending = true;
    this.update({ phase: 'reloading', failure: undefined });
    const version = this.readVersion;
    try {
      const current = await this.io.read();
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
function profileActor(session: ProfileSession | undefined): ProfileActor | null {
  return session?.state === 'signed-in' && session.subject && session.csrfToken
    ? { subject: session.subject, incarnation: session.csrfToken }
    : null;
}

/** Exactly one observation, with no history to reuse after an interrupted or replaced session. */
export class ProfileEditorSession {
  readonly actor: ProfileActor | null;
  readonly key: readonly ['settings', 'profile', string | null, string | null, string];
  readonly editor: ProfileEditor;
  private active = true;
  constructor(session: ProfileSession, createIO: (owner: ProfileEditorSession) => ProfileEditorIO) {
    this.actor = profileActor(session);
    // routes.ts creates a fresh CSRF token per session; store.ts retains it across credential refreshes.
    this.key = [
      'settings',
      'profile',
      this.actor?.subject ?? null,
      this.actor?.incarnation ?? null,
      crypto.randomUUID(),
    ];
    const io = createIO(this);
    this.editor = new ProfileEditor({ ...io, isCurrent: () => this.isCurrent() && (io.isCurrent?.() ?? true) });
    if (!this.actor) this.editor.unavailable();
  }
  matches(session: ProfileSession | undefined) {
    const actor = profileActor(session);
    return (
      this.active &&
      (!this.actor || this.editor.isActive()) &&
      this.actor?.subject === actor?.subject &&
      this.actor?.incarnation === actor?.incarnation
    );
  }
  isCurrent = () => this.active && !!this.actor && this.editor.isActive();
  retire() {
    this.active = false;
    this.editor.retire();
  }
}

import { profileChanges, type ProfilePatch, type ProfileSaveResult, type ProfileValues } from './profile-data';

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
};
export type ProfileEditorState = {
  known: ProfileValues | null;
  draft: ProfileValues | null;
  attempt: ProfileAttempt | null;
  phase: 'loading' | 'idle' | 'saving' | 'reloading' | 'saved' | 'uncertain' | 'refused' | 'review' | 'unavailable';
  scope: ProfileScope;
  failure?: { status: number; message: string } | undefined;
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
    };
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<ProfileEditorState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  receive(current: ProfileValues) {
    const { known, draft } = this.state;
    if (known && current.accountId !== known.accountId) throw new Error('Profile account changed');
    this.update({
      known: current,
      draft: known && draft ? rebaseProfile(known, draft, current) : current,
      phase: this.state.phase === 'loading' || this.state.phase === 'unavailable' ? 'idle' : this.state.phase,
    });
  }
  unavailable() {
    this.update({ phase: 'unavailable' });
  }
  edit(patch: Partial<ProfileValues>) {
    if (!this.state.draft) return;
    this.update({
      draft: { ...this.state.draft, ...patch },
      phase: this.state.phase === 'saved' ? 'idle' : this.state.phase,
    });
  }
  review() {
    this.update({ phase: this.state.attempt ? 'uncertain' : 'idle', failure: undefined });
  }
  async submit(scope: ProfileScope) {
    const { known, draft, attempt, phase } = this.state;
    if (!known || !draft || attempt || ['saving', 'reloading', 'unavailable'].includes(phase)) return;
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
    if (!this.state.attempt || ['saving', 'reloading'].includes(this.state.phase)) return;
    await this.send(true);
  }
  private async send(recovering: boolean) {
    const attempt = this.state.attempt;
    if (!attempt) return;
    this.update({ phase: 'saving', failure: undefined });
    let result: ProfileSaveResult;
    try {
      result = await this.io.save(attempt);
    } catch {
      this.update({ phase: 'uncertain' });
      return;
    }
    if (!result.ok) {
      const uncertain = recovering || result.status >= 500;
      this.update({
        phase: uncertain ? 'uncertain' : 'refused',
        attempt: uncertain ? attempt : null,
        failure: { status: result.status, message: result.message },
      });
      return;
    }
    // A new acknowledgement and a replay are both historical. Always read the current native profile.
    this.update({ phase: 'reloading' });
    try {
      const current = await this.io.read();
      this.finishRead(current, true);
    } catch {
      this.update({ phase: 'uncertain' });
    }
  }
  private finishRead(current: ProfileValues, acknowledged: boolean) {
    const { attempt, known, draft } = this.state;
    if (known && known.accountId !== current.accountId) throw new Error('Profile account changed');
    if (!draft) {
      this.update({ known: current, draft: current, phase: 'idle', failure: undefined });
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
      });
    } else {
      const nextDraft = known ? rebaseProfile(known, draft, current) : current;
      this.update({
        known: current,
        draft: nextDraft,
        phase: Object.keys(profileChanges(current, nextDraft)).length ? 'review' : 'idle',
        failure: undefined,
      });
    }
    this.io.confirmed?.(current);
  }
  async reload() {
    if (['saving', 'reloading'].includes(this.state.phase)) return;
    this.update({ phase: 'reloading', failure: undefined });
    try {
      this.finishRead(await this.io.read(), false);
    } catch {
      this.update({ phase: this.state.attempt ? 'uncertain' : 'unavailable' });
    }
  }
}

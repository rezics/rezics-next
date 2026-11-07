import { isNotFound, isRedirect } from '@tanstack/react-router';
import type { EditableProfile, ProfileEditing } from './editable-profile-source';
import { EditableProfileReadError, profileReadFailure, type EditableProfileFailure } from './profile-failure';
import type { SettingsContentFailureReader } from './ports/content';

export type ProfileLink = { label: string; url: string };
export type ProfileValues = {
  accountId: string;
  kind: 'actor' | 'organization';
  displayName: string | null;
  biography: string | null;
  // Keep Content's summary intact; a newly uploaded avatar initially has only its native media reference.
  avatar: EditableProfile['avatar'] | { media: string };
  links: ProfileLink[];
  publicViews: { posts: boolean; reviews: boolean; collections: boolean; realms: boolean };
  speakersListed?: boolean;
};
export type ObservedProfile = ProfileValues & { editing?: ProfileEditing };
export type ProfilePatch = {
  displayName?: string | null;
  biography?: string | null;
  avatar?: string | null;
  links?: ProfileLink[];
  publicViews?: Partial<ProfileValues['publicViews']>;
  speakersListed?: boolean;
};
/** The PATCH acknowledges a command. Only a subsequent GET confirms the current profile. */
export type ProfileSaveResult =
  | { ok: true; profile: ProfileValues }
  | { ok: false; status: number; message: string; failure?: EditableProfileFailure };

/** Keep native read status intact across the server-function serialization boundary. */
export type ProfileReadResult =
  | { ok: true; profile: ProfileValues; editing: ProfileEditing }
  | { ok: false; status: number; failure?: EditableProfileFailure };

export async function profileReadResult(
  read: () => Promise<ObservedProfile>,
  mediaFailure: SettingsContentFailureReader = () => undefined,
): Promise<ProfileReadResult> {
  try {
    const current = await read();
    if (!current.editing) throw new Error('Profile unavailable');
    return { ok: true, profile: profileCommandValues(current), editing: current.editing };
  } catch (error) {
    const failure = profileReadFailure(error, mediaFailure);
    if (failure) return { ok: false, status: failure.status, ...(Object.keys(failure).length > 1 ? { failure } : {}) };
    throw error;
  }
}

export function profileReadValue(result: ProfileReadResult): ProfileValues {
  if (!result.ok) throw new EditableProfileReadError(result.status, result.failure);
  return result.profile;
}

export function profileReadObservation(result: ProfileReadResult): ObservedProfile {
  if (!result.ok) throw new EditableProfileReadError(result.status, result.failure);
  return result.editing ? { ...result.profile, editing: result.editing } : result.profile;
}

export function profileReadDenied(
  error: unknown,
  mediaFailure: SettingsContentFailureReader = () => undefined,
): boolean {
  const failure = profileReadFailure(error, mediaFailure);
  return !!failure && [401, 403, 404].includes(failure.status);
}

/** Redirect and not-found remain Start/Router control flow, including after a failed private read. */
export function profileControlFlow(error: unknown): void {
  if (isRedirect(error) || isNotFound(error)) throw error;
}

/** Module, request-helper and serialization faults stay in the same plain unavailable envelope. */
export function profileReadSetupFailure(error: unknown): ProfileReadResult {
  profileControlFlow(error);
  return { ok: false, status: 503 };
}

export function profileSaveSetupFailure(error: unknown): ProfileSaveResult {
  profileControlFlow(error);
  return { ok: false, status: 503, message: '' };
}

/** Server-function transport drops custom properties; only JSON-safe metadata crosses the boundary. */
export function serializeProfileResult<T>(result: T): T {
  return JSON.parse(JSON.stringify(result)) as T;
}

/** Projects the official editable source into the value carried by Settings. */
export function projectProfileRecord(value: EditableProfile, editing: ProfileEditing): ObservedProfile {
  return {
    accountId: value.id,
    kind: value.kind,
    displayName: value.displayName,
    biography: value.bio,
    avatar: value.avatar,
    links: value.links,
    publicViews: value.publicViews,
    ...(value.kind === 'organization' && value.speakersListed !== undefined
      ? { speakersListed: value.speakersListed }
      : {}),
    editing,
  };
}

/** Command operands never carry current field advice. */
export function profileCommandValues(profile: ProfileValues): ProfileValues {
  return {
    accountId: profile.accountId,
    kind: profile.kind,
    displayName: profile.displayName,
    biography: profile.biography,
    avatar: profile.avatar,
    links: profile.links,
    publicViews: { ...profile.publicViews },
    ...(profile.kind === 'organization' && typeof profile.speakersListed === 'boolean'
      ? { speakersListed: profile.speakersListed }
      : {}),
  };
}

/** Native field presence alone does not admit a change. Null means the current read lost advice. */
export function profileFieldAdmitted(
  field: keyof ProfilePatch,
  editing: ProfileEditing | null | undefined,
  flag?: keyof ProfileValues['publicViews'],
): boolean {
  // Existing local fixtures omit advice; production observations always supply it.
  if (editing === undefined) return true;
  if (editing === null || !(field in editing.fields)) return false;
  if (field === 'speakersListed') return 'speakersListed' in editing.fields && editing.fields.speakersListed.applicable;
  const advice = editing.fields[field];
  return (
    advice.applicable &&
    (field !== 'publicViews' || flag === undefined || editing.fields.publicViews.flags.includes(flag))
  );
}

export function profilePatchAdmitted(patch: ProfilePatch, editing: ProfileEditing | null | undefined): boolean {
  return (Object.keys(patch) as (keyof ProfilePatch)[]).every(
    (field) =>
      profileFieldAdmitted(field, editing) &&
      (field !== 'publicViews' ||
        (Object.keys(patch.publicViews!) as (keyof ProfileValues['publicViews'])[]).every((flag) =>
          profileFieldAdmitted(field, editing, flag),
        )),
  );
}

function avatarReference(avatar: object | null): string | null {
  if (!avatar) return null;
  if ('media' in avatar && typeof avatar.media === 'string') return avatar.media;
  // Preserve the earlier adapter's reference shape while existing callers transition to native summaries.
  if ('id' in avatar && typeof avatar.id === 'string') return avatar.id;
  return null;
}

export function profileChanges(before: ProfileValues, after: ProfileValues): ProfilePatch {
  const body: ProfilePatch = {};
  if (before.displayName !== after.displayName) body.displayName = after.displayName;
  if (before.biography !== after.biography) body.biography = after.biography;
  if (avatarReference(before.avatar) !== avatarReference(after.avatar)) body.avatar = avatarReference(after.avatar);
  if (JSON.stringify(before.links) !== JSON.stringify(after.links)) body.links = after.links;
  const publicViews: NonNullable<ProfilePatch['publicViews']> = {};
  for (const key of ['posts', 'reviews', 'collections', 'realms'] as const)
    if (before.publicViews[key] !== after.publicViews[key]) publicViews[key] = after.publicViews[key];
  if (Object.keys(publicViews).length) body.publicViews = publicViews;
  if (
    before.kind === 'organization' &&
    after.kind === 'organization' &&
    typeof after.speakersListed === 'boolean' &&
    before.speakersListed !== after.speakersListed
  )
    body.speakersListed = after.speakersListed;
  return body;
}

/** Matching current fields update the projection only; local preview stays local until original acknowledgement. */
export function profileHasLocalPreview(
  changed: boolean,
  localAvatar: boolean,
  attempt: unknown,
  acknowledged: boolean,
): boolean {
  return changed || localAvatar || attempt != null || acknowledged;
}

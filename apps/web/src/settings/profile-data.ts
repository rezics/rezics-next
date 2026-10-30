import type { KernelClient } from '@rezics/client';
import {
  createEditableProfileSource,
  type EditableProfile,
  type EditableProfileSource,
} from './editable-profile-source';

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
export type ProfilePatch = {
  displayName?: string | null;
  biography?: string | null;
  avatar?: string | null;
  links?: ProfileLink[];
  publicViews?: Partial<ProfileValues['publicViews']>;
  speakersListed?: boolean;
};
/** The PATCH acknowledges a command. Only a subsequent GET confirms the current profile. */
export type ProfileSaveResult = { ok: true; profile: ProfileValues } | { ok: false; status: number; message: string };

function accountProfile(value: EditableProfile): ProfileValues {
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
  };
}

export async function loadProfileRecord(
  client: KernelClient,
  authorization: string,
  accountId: string,
  source: EditableProfileSource = createEditableProfileSource(client),
): Promise<ProfileValues> {
  const profile = await source.read(authorization, accountId);
  if (profile.id !== accountId) throw new Error('Profile unavailable');
  return accountProfile(profile);
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

export async function saveProfileRecord(
  client: KernelClient,
  authorization: string,
  accountId: string,
  before: ProfileValues,
  after: ProfileValues,
  idempotencyKey: string,
): Promise<ProfileSaveResult> {
  if (after.links.length > 5) throw new Error('At most five links are allowed');
  const body = profileChanges(before, after);
  if (!Object.keys(body).length) return { ok: true, profile: before };
  const headers = { authorization, 'idempotency-key': idempotencyKey };
  const result = await client.accounts({ accountId }).patch(body, { headers });
  if (!result.error && result.data) return { ok: true, profile: after };
  const errorBody = result.error?.value;
  const message =
    errorBody && typeof errorBody === 'object' && 'detail' in errorBody && typeof errorBody.detail === 'string'
      ? errorBody.detail
      : '';
  return { ok: false, status: result.status, message };
}

import type { KernelClient } from '@rezics/client';

export type ProfileLink = { label: string; url: string };
export type ProfileValues = {
  accountId: string;
  kind: 'actor' | 'organization';
  displayName: string | null;
  biography: string | null;
  avatar: { id: string; url?: string } | null;
  links: ProfileLink[];
  publicViews: { posts: boolean; reviews: boolean; collections: boolean; realms: boolean };
  speakersListed?: boolean;
};
export type ProfileSaveResult = { ok: true; profile: ProfileValues } | { ok: false; status: number; message: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function accountProfile(value: unknown): ProfileValues {
  if (!record(value) || typeof value.id !== 'string' || (value.kind !== 'actor' && value.kind !== 'organization'))
    throw new Error('Profile unavailable');
  const rawAvatar = value.avatar;
  const avatar =
    record(rawAvatar) && typeof rawAvatar.id === 'string'
      ? { id: rawAvatar.id, ...(typeof rawAvatar.url === 'string' ? { url: rawAvatar.url } : {}) }
      : null;
  const rawViews = record(value.publicViews) ? value.publicViews : {};
  const links = Array.isArray(value.links)
    ? value.links.filter(
        (link): link is ProfileLink => record(link) && typeof link.label === 'string' && typeof link.url === 'string',
      )
    : [];
  return {
    accountId: value.id,
    kind: value.kind,
    displayName: typeof value.displayName === 'string' ? value.displayName : null,
    biography: typeof value.bio === 'string' ? value.bio : null,
    avatar,
    links,
    publicViews: {
      posts: rawViews.posts !== false,
      reviews: rawViews.reviews !== false,
      collections: rawViews.collections !== false,
      realms: rawViews.realms !== false,
    },
    ...(value.kind === 'organization' ? { speakersListed: value.speakersListed === true } : {}),
  };
}

export async function loadProfileRecord(
  client: KernelClient,
  authorization: string,
  accountId: string,
): Promise<ProfileValues> {
  const identity = await client.accounts.get({ query: { ids: accountId }, headers: { authorization } });
  if (identity.error || !identity.data) throw new Error('Profile unavailable');
  const ownIdentity = identity.data.accounts.find((item) => item.id === accountId);
  const handle = ownIdentity?.handle;
  if (!handle) throw new Error('Profile unavailable');

  const result = await client.accounts.get({ query: { handle }, headers: { authorization } });
  if (result.error || !result.data) throw new Error('Profile unavailable');
  const found = result.data.accounts.find((item) => item.id === accountId);
  if (!found) throw new Error('Profile unavailable');
  return accountProfile(found);
}

function changes(before: ProfileValues, after: ProfileValues) {
  const body: Record<string, unknown> = {};
  if (before.displayName !== after.displayName) body.displayName = after.displayName;
  if (before.biography !== after.biography) body.biography = after.biography;
  if (before.avatar?.id !== after.avatar?.id) body.avatar = after.avatar?.id ?? null;
  if (JSON.stringify(before.links) !== JSON.stringify(after.links)) body.links = after.links;
  const publicViews: Record<string, boolean> = {};
  for (const key of ['posts', 'reviews', 'collections', 'realms'] as const)
    if (before.publicViews[key] !== after.publicViews[key]) publicViews[key] = after.publicViews[key];
  if (Object.keys(publicViews).length) body.publicViews = publicViews;
  if (before.kind === 'organization' && after.kind === 'organization' && before.speakersListed !== after.speakersListed)
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
  const body = changes(before, after);
  if (!Object.keys(body).length) return { ok: true, profile: before };
  const result = await client.accounts({ accountId }).patch(body, {
    headers: { authorization, 'idempotency-key': idempotencyKey } as {
      authorization: string;
      'idempotency-key': string;
    },
  });
  if (!result.error && result.data) return { ok: true, profile: after };
  const status = result.status;
  const errorBody = record(result.error?.value) ? result.error.value : undefined;
  const message = typeof errorBody?.detail === 'string' ? errorBody.detail : '';
  return { ok: false, status, message };
}

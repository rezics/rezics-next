import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { loadProfileRecord, saveProfileRecord, type ProfileValues } from './profile-data';
import {
  changePreferences,
  changeCollectionVisibility,
  readOwnedCollections,
  reloadOwnedCollection,
  type OwnedCollection,
  type OwnedCollectionsPage,
  type CollectionVisibilityWrite,
  loadSettingsPage,
  parsePreferenceChange,
  type PreferenceWriteResult,
  type SettingsPage,
} from './preferences';
import type { CollectionVisibility } from '../library/reads';

/** One bounded owner read for one page, made only by the browser query. */
export const readOwnedCollectionsPage = createServerFn({ method: 'GET' })
  .validator((cursor: unknown) => {
    if (cursor !== null && (typeof cursor !== 'string' || cursor.length > 2048)) throw new Error('Invalid cursor');
    return cursor as string | null;
  })
  .handler(async ({ data }): Promise<OwnedCollectionsPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    return readOwnedCollections(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export const saveCollectionVisibility = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('Invalid collection change');
    const value = input as Record<string, unknown>;
    if (
      typeof value.collectionId !== 'string' ||
      !value.collectionId ||
      !Number.isSafeInteger(value.revision) ||
      !['private', 'unlisted', 'public'].includes(String(value.visibility)) ||
      typeof value.idempotencyKey !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.idempotencyKey)
    )
      throw new Error('Invalid collection change');
    return value as {
      collectionId: string;
      revision: number;
      visibility: CollectionVisibility;
      idempotencyKey: string;
    };
  })
  .handler(async ({ data }): Promise<CollectionVisibilityWrite> => {
    setResponseHeader('cache-control', 'private, no-store');
    return changeCollectionVisibility(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export const readOwnedCollection = createServerFn({ method: 'GET' })
  .validator((id: unknown) => {
    if (typeof id !== 'string' || !id) throw new Error('Invalid collection id');
    return id;
  })
  .handler(async ({ data }): Promise<OwnedCollection> => {
    setResponseHeader('cache-control', 'private, no-store');
    return reloadOwnedCollection(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export const readSettingsPage = createServerFn({ method: 'GET' }).handler(async (): Promise<SettingsPage> => {
  setResponseHeader('cache-control', 'private, no-store');
  return loadSettingsPage(kernelClient(), getRequest(), env as Partial<SessionEnv>);
});

export const savePreferences = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const change = parsePreferenceChange(input);
    if (!change) throw new Error('Invalid preferences change');
    return change;
  })
  .handler(async ({ data }): Promise<PreferenceWriteResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return changePreferences(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

/** The public identity read starts only when the browser hydrates the signed-in settings view. */
export const readProfile = createServerFn({ method: 'GET' }).handler(async (): Promise<ProfileValues> => {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  await prepareSession(request, env as Partial<SessionEnv>);
  const authorization = viewerCredential(request);
  const accountId = sessionSubject(request);
  if (!authorization || !accountId) throw new Error('Profile unavailable');
  return loadProfileRecord(kernelClient(), authorization, accountId);
});

export const saveProfile = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid profile change');
    const value = input as { before?: ProfileValues; after?: ProfileValues; idempotencyKey?: string };
    if (!value.before || !value.after || !/^[0-9a-f-]{36}$/i.test(value.idempotencyKey ?? ''))
      throw new Error('Invalid profile change');
    return value as { before: ProfileValues; after: ProfileValues; idempotencyKey: string };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    const accountId = sessionSubject(request);
    if (!authorization || !accountId)
      return { ok: false as const, status: 403, message: 'Sign in to change your profile.' };
    if (data.before.accountId !== accountId || data.after.accountId !== accountId)
      return { ok: false as const, status: 403, message: 'You can only change your own profile.' };
    return saveProfileRecord(kernelClient(), authorization, accountId, data.before, data.after, data.idempotencyKey);
  });

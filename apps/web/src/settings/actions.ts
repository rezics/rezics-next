import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
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

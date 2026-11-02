import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, requestCsrfToken, sessionSubject, viewerCredential } from '../session/request';
import { loadProfileRecord, profileReadResult, saveProfileRecord } from './profile-data';
import { EditableProfileReadError } from './editable-profile-source';
import { parseProfileWrite } from './profile-write-input';
import {
  loadManagedAccounts,
  managedAccountsException,
  parseManagedAccountsCursors,
  type ManagedAccountsResult,
} from './managed-accounts-read';
import {
  changePreferences,
  changeCollectionVisibility,
  changeNotifications,
  readOwnedCollections,
  reloadOwnedCollection,
  type OwnedCollection,
  type OwnedCollectionsPage,
  type CollectionVisibilityWrite,
  loadSettingsPage,
  parseNotificationChange,
  parsePreferenceChange,
  type NotificationWriteResult,
  type PreferenceWriteResult,
  type SettingsPage,
} from './preferences';
import type { CollectionVisibility } from '../library/reads';
import { collectionPrivacyRead, type CollectionPrivacyRead } from './collection-privacy-data';

/** One bounded owner read for one page, made only by the browser query. */
export const readOwnedCollectionsPage = createServerFn({ method: 'GET' })
  .validator((cursor: unknown) => {
    if (cursor !== null && (typeof cursor !== 'string' || cursor.length > 2048)) throw new Error('Invalid cursor');
    return cursor as string | null;
  })
  .handler(async ({ data }): Promise<CollectionPrivacyRead<OwnedCollectionsPage>> => {
    setResponseHeader('cache-control', 'private, no-store');
    return collectionPrivacyRead(() =>
      readOwnedCollections(kernelClient(), getRequest(), env as Partial<SessionEnv>, data),
    );
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
  .handler(async ({ data }): Promise<CollectionPrivacyRead<OwnedCollection>> => {
    setResponseHeader('cache-control', 'private, no-store');
    return collectionPrivacyRead(() =>
      reloadOwnedCollection(kernelClient(), getRequest(), env as Partial<SessionEnv>, data),
    );
  });

export const readSettingsPage = createServerFn({ method: 'GET' }).handler(async (): Promise<SettingsPage> => {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  const page = await loadSettingsPage(kernelClient(), request, env as Partial<SessionEnv>);
  if (!page.signedIn) return page;
  return { ...page, csrfToken: requestCsrfToken(request) };
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

/** The supported self-profile projection starts only in the signed-in browser settings view. */
export const readProfile = createServerFn({ method: 'GET' }).handler(async () => {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  await prepareSession(request, env as Partial<SessionEnv>);
  const authorization = viewerCredential(request);
  const accountId = sessionSubject(request);
  return profileReadResult(async () => {
    if (!authorization || !accountId) throw new EditableProfileReadError(401);
    return loadProfileRecord(kernelClient(), authorization, accountId);
  });
});

export const saveProfile = createServerFn({ method: 'POST' })
  .validator(parseProfileWrite)
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

export const saveNotifications = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const change = parseNotificationChange(input);
    if (!change) throw new Error('Invalid notification preferences change');
    return change;
  })
  .handler(async ({ data }): Promise<NotificationWriteResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return changeNotifications(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export const readManagedAccountsInventory = createServerFn({ method: 'GET' })
  .validator(parseManagedAccountsCursors)
  .handler(async ({ data }): Promise<ManagedAccountsResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      const request = getRequest();
      await prepareSession(request, env as Partial<SessionEnv>);
      const authorization = viewerCredential(request);
      const subject = sessionSubject(request);
      if (!authorization || !subject) return { ok: false, kind: 'denied', status: null, code: null };
      // The native endpoint verifies that this is the current human, never an operated account.
      return loadManagedAccounts(kernelClient(), authorization, subject, data, request.signal);
    } catch (error) {
      return managedAccountsException(error);
    }
  });

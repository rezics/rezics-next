import type { KernelClient } from '@rezics/client';
import { MediaProblem } from '../media/kernel';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { readLibraryResult, type CollectionVisibility } from '../library/reads';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';

export type SpoilerLevel = 0 | 1 | 2;
export type Suitability = 'blur' | 'show';
export type ReadingPreferences = { spoilerLevel: SpoilerLevel; suitability: Suitability; version: number };
export type NotificationPreferences = Record<string, boolean>;
export type NotificationPatch = Record<string, boolean | null> | null;

export type SettingsPage =
  | { signedIn: false }
  | {
      signedIn: true;
      preferences: ReadingPreferences;
      notifications?: NotificationPreferences;
      csrfToken?: string | null;
      securityHref: string | null;
    };

export type PreferenceChange = {
  expectedVersion: number;
  spoilerLevel?: SpoilerLevel;
  suitability?: Suitability;
  idempotencyKey: string;
};

export type PreferenceWriteResult =
  | { ok: true; preferences: ReadingPreferences }
  | { ok: false; reason: 'closed' | 'conflict' | 'forbidden' | 'invalid' | 'unavailable' };

export type OwnedCollection = { id: string; title: string; visibility: CollectionVisibility; revision: number };
export type OwnedCollectionsPage = { collections: OwnedCollection[]; next: string | null };
export type CollectionVisibilityWrite =
  | { ok: true; collection: OwnedCollection }
  | { ok: false; reason: 'conflict' | 'forbidden' | 'invalid' | 'unavailable' };

function ownedCollection(value: {
  id: string;
  title: string;
  visibility: CollectionVisibility;
  revision: number;
}): OwnedCollection {
  return { id: value.id, title: value.title, visibility: value.visibility, revision: value.revision };
}

/** One bounded owner read for the requested page. */
export async function readOwnedCollections(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  cursor: string | null,
): Promise<OwnedCollectionsPage> {
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  const accountId = sessionSubject(request);
  if (!authorization || !accountId) throw new Error('Sign in required');
  const result = await client.accounts({ accountId }).collections.get({
    query: { limit: 20, ...(cursor ? { cursor } : {}) },
    headers: { authorization },
  });
  const page = readLibraryResult(result);
  return { collections: page.collections.map(ownedCollection), next: page.next };
}

export async function changeCollectionVisibility(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { collectionId: string; revision: number; visibility: CollectionVisibility; idempotencyKey: string },
): Promise<CollectionVisibilityWrite> {
  try {
    await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    if (!authorization || !sessionSubject(request)) return { ok: false, reason: 'forbidden' };
    const result = await client
      .collections({ collectionId: input.collectionId })
      .patch(
        { revision: input.revision, visibility: input.visibility },
        { headers: { authorization, 'idempotency-key': input.idempotencyKey } as { 'idempotency-key': string } },
      );
    if (!result.error && result.data?.collection)
      return { ok: true, collection: ownedCollection(result.data.collection) };
    if (result.status === 409) return { ok: false, reason: 'conflict' };
    if (result.status === 400 || result.status === 422) return { ok: false, reason: 'invalid' };
    if (result.status === 401 || result.status === 403) return { ok: false, reason: 'forbidden' };
    return { ok: false, reason: 'unavailable' };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

export async function reloadOwnedCollection(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  collectionId: string,
): Promise<OwnedCollection> {
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  if (!authorization || !sessionSubject(request)) throw new Error('Sign in required');
  const result = await client
    .collections({ collectionId })
    .get({ query: { view: 'FULL' }, headers: { authorization } });
  return ownedCollection(readLibraryResult(result).collection);
}

export type NotificationChange = {
  expectedVersion: number;
  notifications: NotificationPatch;
  idempotencyKey: string;
};

export type NotificationWriteResult =
  | { ok: true; notifications: NotificationPreferences; version: number }
  | { ok: false; reason: 'closed' | 'conflict' | 'forbidden' | 'invalid' | 'unavailable' };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The write a request asks for, or `undefined` when it names no setting or carries a value the kernel would refuse. */
export function parsePreferenceChange(input: unknown): PreferenceChange | undefined {
  if (!isRecord(input)) return undefined;
  const { expectedVersion, spoilerLevel, suitability, idempotencyKey } = input;
  if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 0) return undefined;
  if (typeof idempotencyKey !== 'string' || !uuid.test(idempotencyKey)) return undefined;
  if (spoilerLevel !== undefined && spoilerLevel !== 0 && spoilerLevel !== 1 && spoilerLevel !== 2) return undefined;
  if (suitability !== undefined && suitability !== 'blur' && suitability !== 'show') return undefined;
  if (spoilerLevel === undefined && suitability === undefined) return undefined;
  return {
    expectedVersion: expectedVersion as number,
    idempotencyKey,
    ...(spoilerLevel !== undefined ? { spoilerLevel } : {}),
    ...(suitability !== undefined ? { suitability } : {}),
  };
}

/** A notification merge patch, or `undefined` if it has no valid optional change. */
export function parseNotificationChange(input: unknown): NotificationChange | undefined {
  if (!isRecord(input)) return undefined;
  const { expectedVersion, notifications, idempotencyKey } = input;
  if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 0) return undefined;
  if (typeof idempotencyKey !== 'string' || !uuid.test(idempotencyKey)) return undefined;
  if (notifications !== null) {
    if (!isRecord(notifications) || Object.keys(notifications).length === 0) return undefined;
    if (
      Object.entries(notifications).some(
        ([kind, value]) => !/^[a-z][a-z0-9_]*$/.test(kind) || (typeof value !== 'boolean' && value !== null),
      )
    )
      return undefined;
  }
  return {
    expectedVersion: expectedVersion as number,
    notifications: notifications === null ? null : (notifications as Record<string, boolean | null>),
    idempotencyKey,
  };
}

function present(preferences: ReadingPreferences): ReadingPreferences {
  return {
    spoilerLevel: preferences.spoilerLevel,
    suitability: preferences.suitability,
    version: preferences.version,
  };
}

/** The Auth site owns password, passkeys and sessions; the settings page only links to them. */
function securityHref(sessionEnv: Partial<SessionEnv>): string | null {
  if (!sessionEnv.AUTH_ISSUER) return null;
  try {
    return new URL('/security', sessionEnv.AUTH_ISSUER).href;
  } catch {
    return null;
  }
}

/** One session read and one `GET /v1/accounts/<id>/preferences` for the signed-in account. */
export async function loadSettingsPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
): Promise<SettingsPage> {
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  const accountId = sessionSubject(request);
  if (!authorization || !accountId) return { signedIn: false };
  const result = await client.accounts({ accountId }).preferences.get({ headers: { authorization } });
  const data = readLibraryResult(result);
  return {
    signedIn: true,
    preferences: present(data),
    ...(isRecord(data.notifications) ? { notifications: data.notifications as NotificationPreferences } : {}),
    securityHref: securityHref(sessionEnv),
  };
}

function problemCode(error: unknown): unknown {
  return isRecord(error) && isRecord(error.value) ? error.value.code : undefined;
}

/** One session read and one `PATCH` carrying the version the person read. A stale version changes nothing. */
export async function changePreferences(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  change: PreferenceChange,
): Promise<PreferenceWriteResult> {
  try {
    await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    const accountId = sessionSubject(request);
    if (!authorization || !accountId) return { ok: false, reason: 'forbidden' };
    const { idempotencyKey, ...body } = change;
    const result = await client.accounts({ accountId }).preferences.patch(body, {
      headers: { authorization, 'idempotency-key': idempotencyKey } as { 'idempotency-key': string },
    });
    if (!result.error && result.data) return { ok: true, preferences: present(result.data) };
    const status = result.status;
    if (status === 409 && problemCode(result.error) === 'conflict') return { ok: false, reason: 'conflict' };
    if (status === 400 || status === 422) return { ok: false, reason: 'invalid' };
    if (status === 401 || status === 403) return { ok: false, reason: 'forbidden' };
    return { ok: false, reason: 'unavailable' };
  } catch (error) {
    if (isPlatformClosedError(error)) return { ok: false, reason: 'closed' };
    return { ok: false, reason: 'unavailable' };
  }
}

/** One session read and one JSON Merge Patch for a notification change. */
export async function changeNotifications(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  change: NotificationChange,
): Promise<NotificationWriteResult> {
  try {
    await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    const accountId = sessionSubject(request);
    if (!authorization || !accountId) return { ok: false, reason: 'forbidden' };
    const { idempotencyKey, ...body } = change;
    const preferences = client.accounts({ accountId }).preferences;
    const result = await preferences.patch(body as Parameters<typeof preferences.patch>[0], {
      headers: {
        authorization,
        'idempotency-key': idempotencyKey,
        'content-type': 'application/merge-patch+json',
      } as { 'idempotency-key': string; 'content-type': string },
    });
    if (!result.error && result.data)
      return {
        ok: true,
        notifications: { ...result.data.notifications } as NotificationPreferences,
        version: result.data.version,
      };
    const status = result.status;
    if (status === 409 && problemCode(result.error) === 'conflict') return { ok: false, reason: 'conflict' };
    if (status === 400 || status === 422) return { ok: false, reason: 'invalid' };
    if (status === 401 || status === 403) return { ok: false, reason: 'forbidden' };
    return { ok: false, reason: 'unavailable' };
  } catch (error) {
    if (error instanceof MediaProblem && error.problem.code === 'forbidden') return { ok: false, reason: 'forbidden' };
    if (isPlatformClosedError(error)) return { ok: false, reason: 'closed' };
    return { ok: false, reason: 'unavailable' };
  }
}

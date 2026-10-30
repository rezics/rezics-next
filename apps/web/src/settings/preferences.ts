import type { KernelClient } from '@rezics/client';
import { MediaProblem } from '../media/kernel';
import { isPlatformClosedError } from '../kernel/platform-closed';
import type { CollectionVisibility } from '../library/reads';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { securityHrefFromIssuer } from './account-safety-links';
import { collectionPrivacyFailure, readCollectionPrivacyResult } from './collection-privacy-data';

export type SpoilerLevel = 0 | 1 | 2;
export type Suitability = 'blur' | 'show';
export type ReadingPreferences = { spoilerLevel: SpoilerLevel; suitability: Suitability; version: number };
export type NotificationPreferences = Record<string, boolean>;
export type NotificationPatch = Record<string, boolean | null> | null;
export type NativePreferenceFailure = {
  status: number | null;
  code?: string;
  retryable?: boolean;
  requestId?: string;
  retryAfter?: string;
};

export type SettingsPage =
  | { signedIn: false }
  | {
      signedIn: true;
      preferences: ReadingPreferences;
      notifications?: NotificationPreferences;
      csrfToken?: string | null;
      securityHref: string | null;
    }
  | {
      signedIn: true;
      state: 'closed' | 'preparing' | 'unavailable';
      failure: NativePreferenceFailure;
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
  | {
      ok: false;
      reason: 'closed' | 'conflict' | 'forbidden' | 'invalid' | 'preparing' | 'unavailable';
      failure?: NativePreferenceFailure;
    };

export type OwnedCollection = { id: string; title: string; visibility: CollectionVisibility; revision: number };
export type OwnedCollectionsPage = { collections: OwnedCollection[]; next: string | null };
export type CollectionVisibilityWrite =
  | { ok: true; collection: OwnedCollection }
  | { ok: false; reason: 'closed' | 'conflict' | 'forbidden' | 'invalid' | 'unavailable' };

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
  if (!authorization || !accountId) throw new Error('Collection privacy forbidden');
  const result = await client.accounts({ accountId }).collections.get({
    query: { limit: 20, ...(cursor ? { cursor } : {}) },
    headers: { authorization },
  });
  const page = readCollectionPrivacyResult(result);
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
    if (failureDetails(result.error, result.status).code === 'platform_closed') return { ok: false, reason: 'closed' };
    if (result.status === 401 || result.status === 403) return { ok: false, reason: 'forbidden' };
    return { ok: false, reason: 'unavailable' };
  } catch (error) {
    return { ok: false, reason: collectionPrivacyFailure(error) };
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
  if (!authorization || !sessionSubject(request)) throw new Error('Collection privacy forbidden');
  const result = await client
    .collections({ collectionId })
    .get({ query: { view: 'FULL' }, headers: { authorization } });
  return ownedCollection(readCollectionPrivacyResult(result).collection);
}

export type NotificationChange = {
  expectedVersion: number;
  notifications: NotificationPatch;
  idempotencyKey: string;
};

export type NotificationWriteResult =
  | { ok: true; notifications: NotificationPreferences; version: number }
  | {
      ok: false;
      reason: 'closed' | 'conflict' | 'forbidden' | 'invalid' | 'preparing' | 'unavailable';
      failure?: NativePreferenceFailure;
    };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failureDetails(value: unknown, status?: number, headers?: Headers): NativePreferenceFailure {
  const root = isRecord(value) ? value : undefined;
  const problem = root && isRecord(root.value) ? root.value : root && isRecord(root.problem) ? root.problem : root;
  const nativeStatus =
    status ??
    (root && typeof root.status === 'number'
      ? root.status
      : problem && typeof problem.status === 'number'
        ? problem.status
        : null);
  const retryAfter =
    headers?.get('retry-after') ??
    (value instanceof MediaProblem ? new Headers(value.headers).get('retry-after') : undefined) ??
    (root && typeof root.retryAfter === 'string' ? root.retryAfter : undefined);
  return {
    status: nativeStatus,
    ...(problem && typeof problem.code === 'string' ? { code: problem.code } : {}),
    ...(problem && typeof problem.retryable === 'boolean' ? { retryable: problem.retryable } : {}),
    ...(problem && typeof problem.request_id === 'string'
      ? { requestId: problem.request_id }
      : problem && typeof problem.requestId === 'string'
        ? { requestId: problem.requestId }
        : {}),
    ...(retryAfter ? { retryAfter } : {}),
  };
}

function failureState(failure: NativePreferenceFailure): 'closed' | 'preparing' | 'unavailable' {
  if (failure.code === 'platform_closed') return 'closed';
  // The account preference endpoint has no adopted preparation response. A 503 is a service failure.
  return 'unavailable';
}

function writeFailure(failure: NativePreferenceFailure): PreferenceWriteResult & { ok: false } {
  if (failure.code === 'platform_closed') return { ok: false, reason: 'closed', failure };
  if (failure.status === 401 || failure.status === 403) return { ok: false, reason: 'forbidden', failure };
  if (failure.status === 409 && failure.code === 'conflict') return { ok: false, reason: 'conflict', failure };
  if (failure.status === 400 || failure.status === 422) return { ok: false, reason: 'invalid', failure };
  return { ok: false, reason: failureState(failure), failure };
}

function statusOf(result: { status?: number; error?: unknown }): number | undefined {
  if (typeof result.status === 'number') return result.status;
  return isRecord(result.error) && typeof result.error.status === 'number' ? result.error.status : undefined;
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

function present(preferences: unknown): ReadingPreferences | undefined {
  if (
    !isRecord(preferences) ||
    !Number.isSafeInteger(preferences.version) ||
    (preferences.version as number) < 0 ||
    (preferences.spoilerLevel !== 0 && preferences.spoilerLevel !== 1 && preferences.spoilerLevel !== 2) ||
    (preferences.suitability !== 'blur' && preferences.suitability !== 'show')
  )
    return undefined;
  return {
    spoilerLevel: preferences.spoilerLevel,
    suitability: preferences.suitability,
    version: preferences.version as number,
  };
}

function presentNotifications(value: unknown): NotificationPreferences | undefined {
  if (
    !isRecord(value) ||
    typeof value.reply !== 'boolean' ||
    typeof value.mention !== 'boolean' ||
    Object.values(value).some((enabled) => typeof enabled !== 'boolean')
  )
    return undefined;
  return { ...value } as NotificationPreferences;
}

/** The Auth site owns password, passkeys and sessions; the settings page only links to them. */
function securityHref(sessionEnv: Partial<SessionEnv>): string | null {
  return securityHrefFromIssuer(sessionEnv.AUTH_ISSUER);
}

/** One session read and one `GET /v1/accounts/<id>/preferences` for the signed-in account. */
export async function loadSettingsPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
): Promise<SettingsPage> {
  try {
    await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    const accountId = sessionSubject(request);
    if (!authorization || !accountId) return { signedIn: false };
    const result = await client.accounts({ accountId }).preferences.get({ headers: { authorization } });
    const preferences = !result.error ? present(result.data) : undefined;
    if (!preferences) {
      const failure = failureDetails(result.error ?? result.data, statusOf(result), result.headers);
      return {
        signedIn: true,
        state: failureState(failure),
        failure,
        securityHref: securityHref(sessionEnv),
      };
    }
    const data = result.data as ReadingPreferences & { notifications?: unknown };
    const notifications = presentNotifications(data.notifications);
    return {
      signedIn: true,
      preferences,
      ...(notifications ? { notifications } : {}),
      securityHref: securityHref(sessionEnv),
    };
  } catch (error) {
    const failure = failureDetails(error);
    return {
      signedIn: true,
      state: isPlatformClosedError(error) || failure.code === 'platform_closed' ? 'closed' : failureState(failure),
      failure,
      securityHref: securityHref(sessionEnv),
    };
  }
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
    const preferences = !result.error ? present(result.data) : undefined;
    if (preferences) return { ok: true, preferences };
    return writeFailure(failureDetails(result.error ?? result.data, statusOf(result), result.headers));
  } catch (error) {
    const failure = failureDetails(error);
    if (isPlatformClosedError(error) || failure.code === 'platform_closed')
      return { ok: false, reason: 'closed', failure };
    return writeFailure(failure);
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
    if (!result.error && result.data) {
      const data = result.data as ReadingPreferences & { notifications?: unknown };
      const notifications = presentNotifications(data.notifications);
      const preferences = present(data);
      if (!notifications || !preferences)
        return {
          ok: false,
          reason: 'unavailable',
          failure: failureDetails(result.data, result.status, result.headers),
        };
      return { ok: true, notifications, version: preferences.version };
    }
    return writeFailure(failureDetails(result.error ?? result.data, statusOf(result), result.headers));
  } catch (error) {
    const failure = failureDetails(error);
    if (error instanceof MediaProblem && error.problem.code === 'forbidden')
      return { ok: false, reason: 'forbidden', failure };
    if (isPlatformClosedError(error) || failure.code === 'platform_closed')
      return { ok: false, reason: 'closed', failure };
    return writeFailure(failure);
  }
}

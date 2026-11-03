import type { KernelClient } from '@rezics/client';
import { MediaProblem } from '../media/kernel';
import { isPlatformClosedError } from '../kernel/platform-closed';
import type { CollectionVisibility } from '../library/reads';
import { dynamicCollectionTitle } from '../library/dynamic-collection';
import { getLocale } from '../paraglide/runtime.js';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { securityHrefFromIssuer } from './account-safety-links';
import {
  collectionPrivacyFailure,
  collectionPrivacyFailureMetadata,
  nativePreferenceFailureDetails as failureDetails,
  readCollectionPrivacyResult,
} from './collection-privacy-data';
import type { AccountRenameNavigation } from './account-rename-actions';
import { settingsCommandKeyHeader } from './command-headers';

export type SpoilerLevel = 0 | 1 | 2;
export type Suitability = 'blur' | 'show';
export const shelfPreferenceLayouts = ['grid', 'list', 'table'] as const;
export const shelfPreferenceTabs = ['in_progress', 'planned', 'completed', 'paused', 'dropped', 'all'] as const;
export const shelfPreferenceSortFields = [
  'last_activity',
  'added',
  'finished',
  'title',
  'rating',
  'release_date',
  'progress',
] as const;
export const shelfPreferenceColumns = [
  'cover',
  'title',
  'creator',
  'type',
  'status',
  'progress',
  'rating',
  'added',
  'started',
  'finished',
  'last_activity',
] as const;
export type ShelfPreferenceTab = (typeof shelfPreferenceTabs)[number];
export type ShelfPreferenceSort = {
  field: (typeof shelfPreferenceSortFields)[number];
  direction: 'asc' | 'desc';
};
export type ShelfPreferences = {
  layouts?: Record<string, (typeof shelfPreferenceLayouts)[number]>;
  sorts?: Partial<Record<ShelfPreferenceTab, ShelfPreferenceSort>>;
  gridSize?: 'small' | 'medium' | 'large';
  tableColumns?: (typeof shelfPreferenceColumns)[number][];
};
export type ShelfPreferencePatch = {
  layouts?: Record<string, (typeof shelfPreferenceLayouts)[number] | null> | null;
  sorts?: Partial<
    Record<
      ShelfPreferenceTab,
      { field?: ShelfPreferenceSort['field'] | null; direction?: ShelfPreferenceSort['direction'] | null } | null
    >
  > | null;
  gridSize?: ShelfPreferences['gridSize'] | null;
  tableColumns?: ShelfPreferences['tableColumns'] | null;
};
export type ReadingPreferences = {
  spoilerLevel: SpoilerLevel;
  suitability: Suitability;
  version: number;
  /** The bounded native shelf projection is present on account reads and absent in older fixtures. */
  shelf?: ShelfPreferences;
};
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
      /** The subject resolved by the prepared page request; absent identity is never writable. */
      readonly accountId?: string | null;
      preferences: ReadingPreferences;
      notifications?: NotificationPreferences;
      csrfToken?: string | null;
      securityHref: string | null;
      renameAccount?: AccountRenameNavigation | null;
    }
  | {
      signedIn: true;
      readonly accountId?: string | null;
      state: 'closed' | 'preparing' | 'unavailable';
      failure: NativePreferenceFailure;
      csrfToken?: string | null;
      securityHref: string | null;
      renameAccount?: AccountRenameNavigation | null;
    };

export type PreferenceChange = {
  expectedVersion: number;
  spoilerLevel?: SpoilerLevel;
  suitability?: Suitability;
  shelf?: ShelfPreferencePatch | null;
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
  | {
      ok: false;
      reason: 'closed' | 'conflict' | 'forbidden' | 'invalid' | 'unavailable';
      failure?: NativePreferenceFailure;
    };

type NativeOwnedCollection = NonNullable<
  Awaited<ReturnType<ReturnType<KernelClient['collections']>['get']>>['data']
>['collection'];

function ownedCollection(value: NativeOwnedCollection): OwnedCollection {
  return {
    id: value.id,
    title: 'builtinKind' in value ? dynamicCollectionTitle(value, getLocale()) : value.title,
    visibility: value.visibility,
    revision: value.revision,
  };
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
    const result = await client.collections({ collectionId: input.collectionId }).patch(
      { revision: input.revision, visibility: input.visibility },
      {
        headers: { authorization, 'idempotency-key': settingsCommandKeyHeader(input.idempotencyKey) } as {
          'idempotency-key': string;
        },
      },
    );
    if (!result.error && result.data?.collection)
      return { ok: true, collection: ownedCollection(result.data.collection) };
    const failure = collectionPrivacyFailureMetadata(result.error, result.status, result.headers);
    const metadata = failure ? { failure } : {};
    if (result.status === 409) return { ok: false, reason: 'conflict', ...metadata };
    if (result.status === 400 || result.status === 422) return { ok: false, reason: 'invalid', ...metadata };
    if (failureDetails(result.error, result.status).code === 'platform_closed')
      return { ok: false, reason: 'closed', ...metadata };
    if (result.status === 401 || result.status === 403) return { ok: false, reason: 'forbidden', ...metadata };
    return { ok: false, reason: 'unavailable', ...metadata };
  } catch (error) {
    const failure = collectionPrivacyFailureMetadata(error);
    return { ok: false, reason: collectionPrivacyFailure(error), ...(failure ? { failure } : {}) };
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

const shelfScope = /^(?:all|[A-Za-z][A-Za-z0-9+.-]*:\S+)$/;
function validShelfPatch(value: unknown): value is ShelfPreferencePatch | null {
  if (value === null) return true;
  if (!isRecord(value) || Object.keys(value).some((key) => !['layouts', 'sorts', 'gridSize', 'tableColumns'].includes(key)))
    return false;
  if (value.layouts !== undefined && value.layouts !== null) {
    if (!isRecord(value.layouts) || Object.keys(value.layouts).length > 32) return false;
    if (
      Object.entries(value.layouts).some(
        ([scope, layout]) =>
          scope.length > 256 || !shelfScope.test(scope) || (layout !== null && !shelfPreferenceLayouts.includes(layout as never)),
      )
    )
      return false;
  }
  if (value.sorts !== undefined && value.sorts !== null) {
    if (!isRecord(value.sorts) || Object.keys(value.sorts).some((tab) => !shelfPreferenceTabs.includes(tab as never)))
      return false;
    for (const entry of Object.values(value.sorts)) {
      if (entry === null) continue;
      if (!isRecord(entry) || Object.keys(entry).some((key) => !['field', 'direction'].includes(key))) return false;
      if (
        (entry.field != null && !shelfPreferenceSortFields.includes(entry.field as never)) ||
        (entry.direction != null && entry.direction !== 'asc' && entry.direction !== 'desc')
      )
        return false;
    }
  }
  if (value.gridSize != null && !['small', 'medium', 'large'].includes(String(value.gridSize))) return false;
  if (value.tableColumns != null) {
    if (
      !Array.isArray(value.tableColumns) ||
      value.tableColumns.length < 1 ||
      value.tableColumns.length > shelfPreferenceColumns.length ||
      new Set(value.tableColumns).size !== value.tableColumns.length ||
      value.tableColumns.some((column) => !shelfPreferenceColumns.includes(column as never))
    )
      return false;
  }
  return true;
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
  const { expectedVersion, spoilerLevel, suitability, shelf, idempotencyKey } = input;
  if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 0) return undefined;
  if (typeof idempotencyKey !== 'string' || !uuid.test(idempotencyKey)) return undefined;
  if (spoilerLevel !== undefined && spoilerLevel !== 0 && spoilerLevel !== 1 && spoilerLevel !== 2) return undefined;
  if (suitability !== undefined && suitability !== 'blur' && suitability !== 'show') return undefined;
  if (shelf !== undefined && !validShelfPatch(shelf)) return undefined;
  if (spoilerLevel === undefined && suitability === undefined && shelf === undefined) return undefined;
  return {
    expectedVersion: expectedVersion as number,
    idempotencyKey,
    ...(spoilerLevel !== undefined ? { spoilerLevel } : {}),
    ...(suitability !== undefined ? { suitability } : {}),
    ...(shelf !== undefined ? { shelf: shelf as ShelfPreferencePatch | null } : {}),
  };
}

function presentShelf(value: unknown): ShelfPreferences | undefined {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).some((key) => !['layouts', 'sorts', 'gridSize', 'tableColumns'].includes(key)))
    return undefined;
  if (value.layouts !== undefined) {
    if (
      !isRecord(value.layouts) ||
      Object.keys(value.layouts).length > 32 ||
      Object.entries(value.layouts).some(
        ([scope, layout]) =>
          scope.length > 256 || !shelfScope.test(scope) || !shelfPreferenceLayouts.includes(layout as never),
      )
    )
      return undefined;
  }
  if (value.sorts !== undefined) {
    if (!isRecord(value.sorts) || Object.keys(value.sorts).some((tab) => !shelfPreferenceTabs.includes(tab as never)))
      return undefined;
    for (const entry of Object.values(value.sorts))
      if (
        !isRecord(entry) ||
        Object.keys(entry).some((key) => !['field', 'direction'].includes(key)) ||
        !shelfPreferenceSortFields.includes(entry.field as never) ||
        (entry.direction !== 'asc' && entry.direction !== 'desc')
      )
        return undefined;
  }
  if (value.gridSize !== undefined && !['small', 'medium', 'large'].includes(String(value.gridSize))) return undefined;
  if (value.tableColumns !== undefined) {
    if (
      !Array.isArray(value.tableColumns) ||
      value.tableColumns.length < 1 ||
      value.tableColumns.length > shelfPreferenceColumns.length ||
      new Set(value.tableColumns).size !== value.tableColumns.length ||
      value.tableColumns.some((column) => !shelfPreferenceColumns.includes(column as never))
    )
      return undefined;
  }
  return {
    ...(value.layouts !== undefined
      ? { layouts: { ...value.layouts } as NonNullable<ShelfPreferences['layouts']> }
      : {}),
    ...(value.sorts !== undefined
      ? { sorts: structuredClone(value.sorts) as NonNullable<ShelfPreferences['sorts']> }
      : {}),
    ...(value.gridSize !== undefined ? { gridSize: value.gridSize as NonNullable<ShelfPreferences['gridSize']> } : {}),
    ...(value.tableColumns !== undefined
      ? { tableColumns: [...value.tableColumns] as NonNullable<ShelfPreferences['tableColumns']> }
      : {}),
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
  const shelf = isRecord(preferences) ? presentShelf(preferences.shelf) : undefined;
  if (
    !isRecord(preferences) ||
    !Number.isSafeInteger(preferences.version) ||
    (preferences.version as number) < 0 ||
    (preferences.spoilerLevel !== 0 && preferences.spoilerLevel !== 1 && preferences.spoilerLevel !== 2) ||
    (preferences.suitability !== 'blur' && preferences.suitability !== 'show') ||
    !shelf
  )
    return undefined;
  return {
    spoilerLevel: preferences.spoilerLevel,
    suitability: preferences.suitability,
    version: preferences.version as number,
    shelf,
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
  let accountId: string | null = null;
  try {
    await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    const preparedAccountId = sessionSubject(request);
    if (!authorization || !preparedAccountId) return { signedIn: false };
    accountId = preparedAccountId;
    const result = await client.accounts({ accountId }).preferences.get({ headers: { authorization } });
    const preferences = !result.error ? present(result.data) : undefined;
    if (!preferences) {
      const failure = failureDetails(result.error ?? result.data, statusOf(result), result.headers);
      return {
        signedIn: true,
        accountId,
        state: failureState(failure),
        failure,
        securityHref: securityHref(sessionEnv),
      };
    }
    const data = result.data as ReadingPreferences & { notifications?: unknown };
    const notifications = presentNotifications(data.notifications);
    return {
      signedIn: true,
      accountId,
      preferences,
      ...(notifications ? { notifications } : {}),
      securityHref: securityHref(sessionEnv),
    };
  } catch (error) {
    const failure = failureDetails(error);
    return {
      signedIn: true,
      accountId,
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
    const nativePreferences = client.accounts({ accountId }).preferences;
    const result = await nativePreferences.patch(body as Parameters<typeof nativePreferences.patch>[0], {
      headers: { authorization, 'idempotency-key': settingsCommandKeyHeader(idempotencyKey) } as {
        'idempotency-key': string;
      },
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
        'idempotency-key': settingsCommandKeyHeader(idempotencyKey),
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
    return writeFailure(failureDetails(result.error, statusOf(result), result.headers));
  } catch (error) {
    const failure = failureDetails(error);
    if (error instanceof MediaProblem && error.problem.code === 'forbidden')
      return { ok: false, reason: 'forbidden', failure };
    if (isPlatformClosedError(error) || failure.code === 'platform_closed')
      return { ok: false, reason: 'closed', failure };
    return writeFailure(failure);
  }
}

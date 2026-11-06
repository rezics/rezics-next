import {
  decodePreferenceAdvice,
  decodePreferenceValues,
  PREFERENCE_SHELF_LIMITS,
  type KernelClient,
  type PreferencePage,
  type PreferencePageAction,
  type PreferencePageAdvice,
  type PreferencePageKind,
  type PreferenceShelfAdvice,
} from '@rezics/client';
import { MediaProblem } from '../media/kernel';
import { isPlatformClosedError } from '../kernel/platform-closed';
import type { CollectionVisibility } from '../library/reads';
import { dynamicCollectionTitle } from '../library/dynamic-collection';
import { getLocale } from '../paraglide/runtime.js';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { isSessionUnavailableError } from '../session/unavailable';
import { securityHrefFromIssuer } from './account-safety-links';
import {
  collectionPrivacyFailure,
  collectionPrivacyFailureMetadata,
  nativePreferenceFailureDetails as failureDetails,
  readCollectionPrivacyResult,
} from './collection-privacy-data';
import type { AccountRenameNavigation } from './account-rename-actions';
import { settingsCommandKeyHeader } from './command-headers';

// Shared Profile boundary for the Accounts editor.
export { withProfileDeadline } from './profile-request-deadline';
export { settingsCommandKeyHeader } from './command-headers';
export {
  createEditableProfileSource,
  EditableProfileReadError,
  nativeProfileFailure,
  parseProfilePatchAck,
  type EditableProfileFailure,
} from './editable-profile-source';
export {
  loadProfileRecord,
  profileControlFlow,
  profilePatchAdmitted,
  profileSaveSetupFailure,
  serializeProfileResult,
  type ObservedProfile,
  type ProfilePatch,
} from './profile-data';
export { profileFieldErrors } from './profile-write';

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
export type ReadingAdvice = PreferencePageAdvice;
export type ShelfAdvice = PreferenceShelfAdvice;

export function ownerMayChangeShelf(advice: ReadingAdvice | undefined): boolean {
  return (
    advice?.viewerState === 'current' &&
    advice.allowedActions.update.allowed === true &&
    advice.shelfAdvice !== undefined
  );
}

export function shelfAdviceFor(shelf: ShelfPreferences = {}): ShelfAdvice {
  return {
    supported: {
      layouts: [...shelfPreferenceLayouts],
      tabs: [...shelfPreferenceTabs],
      sortFields: [...shelfPreferenceSortFields],
      sortDirections: ['asc', 'desc'],
      gridSizes: ['small', 'medium', 'large'],
      tableColumns: [...shelfPreferenceColumns],
    },
    limits: { ...PREFERENCE_SHELF_LIMITS },
    effective: {
      ...(shelf.layouts !== undefined ? { layouts: { ...shelf.layouts } } : {}),
      ...(shelf.sorts !== undefined ? { sorts: structuredClone(shelf.sorts) } : {}),
      ...(shelf.gridSize !== undefined ? { gridSize: shelf.gridSize } : {}),
      ...(shelf.tableColumns !== undefined ? { tableColumns: [...shelf.tableColumns] } : {}),
    },
    defaults: {},
  };
}

export function withShelfAdvice(
  values: Pick<ReadingPreferences, 'spoilerLevel' | 'suitability' | 'version' | 'shelf'>,
  writable = true,
): ReadingPreferences {
  const shelf = values.shelf ?? {};
  return {
    spoilerLevel: values.spoilerLevel,
    suitability: values.suitability,
    version: values.version,
    shelf,
    advice: {
      viewerState: 'current',
      allowedActions: {
        read: { allowed: true },
        update: writable ? { allowed: true } : { allowed: false, reason: 'not_authorized' },
      },
      reading: {
        supported: { spoilerLevels: [0, 1, 2], suitability: ['blur', 'show'] },
        effective: { spoilerLevel: values.spoilerLevel, suitability: values.suitability },
        defaults: { spoilerLevel: 0, suitability: 'blur' },
      },
      shelfAdvice: shelfAdviceFor(shelf),
    },
  };
}
export type ReadingPreferences = {
  spoilerLevel: SpoilerLevel;
  suitability: Suitability;
  version: number;
  /** The bounded native shelf projection is present on account reads and absent in older fixtures. */
  shelf?: ShelfPreferences;
  /** Owner-supplied choices and actions; absent when the envelope is missing or malformed. */
  advice?: ReadingAdvice;
};
export type NotificationPreferences = Record<string, boolean>;
export type NotificationPatch = Record<string, boolean | null> | null;
export type { PreferencePage, PreferencePageAction, PreferencePageKind };
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
      page?: PreferencePage;
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

export type OwnedCollection = {
  id: string;
  title: string;
  kind: 'curated' | 'dynamic' | 'builtin';
  membershipKind: 'curated' | 'dynamic';
  builtinKind?: 'everything' | 'state' | 'liked';
  builtin?:
    | { kind: 'everything' | 'liked' }
    | { kind: 'state'; profileId: string; stateSetId: string; stateId: string };
  visibility: CollectionVisibility;
  /** Logical built-ins have no command revision. */
  revision: number | null;
  /** Native advice lists only visibility changes the current viewer may make. */
  allowedVisibilityActions: CollectionVisibility[];
};
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

const collectionVisibilities = ['private', 'unlisted', 'public'] as const;
type OwnerManagementRead = {
  ownerManagement: 'owner';
  ownerAccountId: string;
  collections?: unknown;
  next?: unknown;
  collection?: unknown;
};

function ownedCollection(value: unknown, ownerAccountId: string): OwnedCollection {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    value.curatorAccountId !== ownerAccountId ||
    (value.visibility !== 'private' && value.visibility !== 'unlisted' && value.visibility !== 'public') ||
    !Array.isArray(value.allowedVisibilityActions) ||
    value.allowedVisibilityActions.some((action) => !collectionVisibilities.includes(action as CollectionVisibility))
  )
    throw new Error('Collection privacy unavailable');

  const allowedVisibilityActions = value.allowedVisibilityActions as CollectionVisibility[];
  if (
    new Set(allowedVisibilityActions).size !== allowedVisibilityActions.length ||
    allowedVisibilityActions.includes(value.visibility)
  )
    throw new Error('Collection privacy unavailable');

  const native = value as unknown as NativeOwnedCollection;
  const title = typeof value.title === 'string' ? value.title : dynamicCollectionTitle(native, getLocale());
  if (!title) throw new Error('Collection privacy unavailable');

  if ('builtinKind' in value) {
    if (
      value.membershipKind !== 'dynamic' ||
      !['everything', 'state', 'liked'].includes(String(value.builtinKind)) ||
      !isRecord(value.builtin) ||
      value.builtin.kind !== value.builtinKind ||
      value.visibility !== 'private' ||
      allowedVisibilityActions.length !== 0
    )
      throw new Error('Collection privacy unavailable');
    if (
      value.builtin.kind === 'state' &&
      (typeof value.builtin.profileId !== 'string' ||
        typeof value.builtin.stateSetId !== 'string' ||
        typeof value.builtin.stateId !== 'string')
    )
      throw new Error('Collection privacy unavailable');
    return {
      id: value.id,
      title,
      kind: 'builtin',
      membershipKind: 'dynamic',
      builtinKind: value.builtinKind as NonNullable<OwnedCollection['builtinKind']>,
      builtin: value.builtin as NonNullable<OwnedCollection['builtin']>,
      visibility: 'private',
      revision: null,
      allowedVisibilityActions: [],
    };
  }

  if (value.membershipKind !== 'curated' && value.membershipKind !== 'dynamic')
    throw new Error('Collection privacy unavailable');
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1)
    throw new Error('Collection privacy unavailable');
  return {
    id: value.id,
    title,
    kind: value.membershipKind === 'curated' ? 'curated' : 'dynamic',
    membershipKind: value.membershipKind,
    visibility: value.visibility,
    revision: value.revision as number,
    allowedVisibilityActions,
  };
}

function ownerPage(value: unknown, ownerAccountId: string): OwnedCollectionsPage {
  if (
    !isRecord(value) ||
    value.ownerManagement !== 'owner' ||
    value.ownerAccountId !== ownerAccountId ||
    !Array.isArray(value.collections) ||
    value.collections.length > 20 ||
    (value.next !== null && typeof value.next !== 'string')
  )
    throw new Error('Collection privacy unavailable');
  return {
    collections: value.collections.map((collection) => ownedCollection(collection, ownerAccountId)),
    next: value.next as string | null,
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
  const getOwnerPage = client.collections.get as unknown as (options: {
    query: { curatorAccountId: string; limit: 20; ownerManagement: true; cursor?: string };
    headers: { authorization: string };
  }) => Promise<unknown>;
  const result = await getOwnerPage({
    query: {
      curatorAccountId: accountId,
      limit: 20,
      ownerManagement: true,
      ...(cursor !== null ? { cursor } : {}),
    },
    headers: { authorization },
  });
  const page = readCollectionPrivacyResult(
    result as { data?: unknown; error?: unknown; status?: number; headers?: HeadersInit },
  ) as OwnerManagementRead;
  return ownerPage(page, accountId);
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
    const accountId = sessionSubject(request);
    if (!authorization || !accountId) return { ok: false, reason: 'forbidden' };
    const patchWithOwnerAdvice = client.collections({ collectionId: input.collectionId }).patch as unknown as (
      body: { revision: number; visibility: CollectionVisibility },
      options: {
        query: { ownerManagement: true };
        headers: { authorization: string; 'idempotency-key': string };
      },
    ) => Promise<{ data?: { collection?: unknown } | null; error?: unknown; status?: number; headers?: HeadersInit }>;
    const result = await patchWithOwnerAdvice(
      { revision: input.revision, visibility: input.visibility },
      {
        query: { ownerManagement: true },
        headers: { authorization, 'idempotency-key': settingsCommandKeyHeader(input.idempotencyKey) },
      },
    );
    if (!result.error && result.data?.collection)
      return { ok: true, collection: ownedCollection(result.data.collection, accountId) };
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
  const accountId = sessionSubject(request);
  if (!authorization || !accountId) throw new Error('Collection privacy forbidden');
  const getOwnerCollection = client.collections({ collectionId }).get as unknown as (options: {
    query: { view: 'FULL'; ownerManagement: true };
    headers: { authorization: string };
  }) => Promise<unknown>;
  const result = await getOwnerCollection({
    query: { view: 'FULL', ownerManagement: true },
    headers: { authorization },
  });
  const response = readCollectionPrivacyResult(
    result as { data?: unknown; error?: unknown; status?: number; headers?: HeadersInit },
  ) as OwnerManagementRead;
  return ownedCollection(response.collection, accountId);
}

export type NotificationChange = {
  expectedVersion: number;
  notifications: NotificationPatch;
  idempotencyKey: string;
};

export type NotificationWriteResult =
  | { ok: true; notifications: NotificationPreferences; version: number; page: PreferencePage }
  | {
      ok: false;
      reason: 'closed' | 'conflict' | 'forbidden' | 'invalid' | 'preparing' | 'unavailable';
      page?: PreferencePage;
      failure?: NativePreferenceFailure;
    };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

const shelfScope = /^(?:all|[A-Za-z][A-Za-z0-9+.-]*:\S+)$/;
function validShelfPatch(value: unknown): value is ShelfPreferencePatch | null {
  if (value === null) return true;
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !['layouts', 'sorts', 'gridSize', 'tableColumns'].includes(key))
  )
    return false;
  if (value.layouts !== undefined && value.layouts !== null) {
    if (!isRecord(value.layouts) || Object.keys(value.layouts).length > 32) return false;
    if (
      Object.entries(value.layouts).some(
        ([scope, layout]) =>
          scope.length > 256 ||
          !shelfScope.test(scope) ||
          (layout !== null && !shelfPreferenceLayouts.includes(layout as never)),
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
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !['layouts', 'sorts', 'gridSize', 'tableColumns'].includes(key))
  )
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

function presentAdvice(value: unknown, preferences: ReadingPreferences): ReadingAdvice | undefined {
  const page = decodePreferenceAdvice(value);
  if (
    !page ||
    page.reading.effective.spoilerLevel !== preferences.spoilerLevel ||
    page.reading.effective.suitability !== preferences.suitability ||
    !page.reading.supported.spoilerLevels.includes(preferences.spoilerLevel) ||
    !page.reading.supported.suitability.includes(preferences.suitability)
  )
    return undefined;
  return page;
}

function present(preferences: unknown): ReadingPreferences | undefined {
  const values = decodePreferenceValues(preferences);
  const shelf = isRecord(preferences) ? presentShelf(preferences.shelf) : undefined;
  if (!values || !shelf) return undefined;
  const reading: ReadingPreferences = {
    spoilerLevel: values.spoilerLevel,
    suitability: values.suitability,
    version: values.version,
    shelf,
  };
  const advice = presentAdvice(preferences, reading);
  return advice ? { ...reading, advice } : reading;
}

function presentPageKind(value: unknown): PreferencePageKind | undefined {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ['kind', 'optional', 'default', 'enabled']) ||
    typeof value.kind !== 'string' ||
    !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(value.kind) ||
    typeof value.optional !== 'boolean' ||
    typeof value.default !== 'boolean' ||
    typeof value.enabled !== 'boolean' ||
    (!value.optional && (!value.default || !value.enabled))
  )
    return undefined;
  return { kind: value.kind, optional: value.optional, default: value.default, enabled: value.enabled };
}

function presentPageAction(value: unknown): PreferencePageAction | undefined {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ['name', 'expectedVersion']) ||
    (value.name !== 'edit' && value.name !== 'reset') ||
    !Number.isSafeInteger(value.expectedVersion) ||
    (value.expectedVersion as number) < 0
  )
    return undefined;
  return { name: value.name, expectedVersion: value.expectedVersion as number };
}

/** The native catalogue projection, or `undefined` when it is missing or not a closed page. */
export function presentPreferencePage(value: unknown, version?: number): PreferencePage | undefined {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ['version', 'kinds', 'actions']) ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 0 ||
    !Array.isArray(value.kinds) ||
    value.kinds.length < 1 ||
    value.kinds.length > 32
  )
    return undefined;
  if (!Array.isArray(value.actions) || value.actions.length > 2) return undefined;
  const pageVersion = value.version as number;
  if (version !== undefined && pageVersion !== version) return undefined;
  const kinds = value.kinds.map(presentPageKind);
  const actions = value.actions.map(presentPageAction);
  if (kinds.some((entry) => !entry) || actions.some((entry) => !entry)) return undefined;
  const presentedKinds = kinds as PreferencePageKind[];
  if (new Set(presentedKinds.map((entry) => entry.kind)).size !== presentedKinds.length) return undefined;
  const presentedActions = actions as PreferencePageAction[];
  if (new Set(presentedActions.map((entry) => entry.name)).size !== presentedActions.length) return undefined;
  if (presentedActions.some((entry) => entry.expectedVersion !== pageVersion)) return undefined;
  return { version: pageVersion, kinds: presentedKinds, actions: presentedActions };
}

export function optionalNotifications(page: PreferencePage): NotificationPreferences {
  return Object.fromEntries(page.kinds.filter((entry) => entry.optional).map((entry) => [entry.kind, entry.enabled]));
}

export function preferencePageAllows(page: PreferencePage, name: PreferencePageAction['name']): boolean {
  return page.actions.some((action) => action.name === name);
}

function presentNotifications(value: unknown, page?: PreferencePage): NotificationPreferences | undefined {
  if (page) {
    const notifications = optionalNotifications(page);
    return Object.keys(notifications).length > 0 ? notifications : undefined;
  }
  if (
    !isRecord(value) ||
    typeof value.reply !== 'boolean' ||
    typeof value.mention !== 'boolean' ||
    Object.values(value).some((enabled) => typeof enabled !== 'boolean')
  )
    return undefined;
  return { ...value } as NotificationPreferences;
}

function currentPageFrom(value: unknown, version: number, expectedWritable?: boolean): PreferencePage | undefined {
  const keys = [
    'spoilerLevel',
    'suitability',
    'shelf',
    'notifications',
    'version',
    'page',
    'viewerState',
    'allowedActions',
    'reading',
  ] as const;
  if (
    !isRecord(value) ||
    keys.some((key) => !(key in value)) ||
    !isRecord(value.notifications) ||
    Object.values(value.notifications).some((enabled) => typeof enabled !== 'boolean')
  )
    return undefined;
  const advice = decodePreferenceAdvice(value);
  if (!advice || !advice.allowedActions.read.allowed) return undefined;
  const writable = advice.allowedActions.update.allowed;
  if (expectedWritable !== undefined && writable !== expectedWritable) return undefined;
  const page = presentPreferencePage(value.page, version);
  if (!page || page.actions.length > 0 !== writable) return undefined;
  return page;
}

function conflictPageFrom(value: unknown): PreferencePage | undefined {
  if (!isRecord(value)) return undefined;
  const problem = isRecord(value.value) ? value.value : isRecord(value.problem) ? value.problem : value;
  if (problem.code !== 'conflict') return undefined;
  return presentPreferencePage(problem.page ?? value.page);
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
  options: { signal?: AbortSignal } = {},
): Promise<SettingsPage> {
  const signal = options.signal;
  let accountId: string | null = null;
  try {
    signal?.throwIfAborted();
    await prepareSession(request, sessionEnv);
    signal?.throwIfAborted();
    const authorization = viewerCredential(request);
    const preparedAccountId = sessionSubject(request);
    if (!authorization || !preparedAccountId) return { signedIn: false };
    accountId = preparedAccountId;
    signal?.throwIfAborted();
    const result = await client.accounts({ accountId }).preferences.get({
      headers: { authorization },
      ...(signal ? { fetch: { signal } } : {}),
    });
    signal?.throwIfAborted();
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
    const page = currentPageFrom(result.data, preferences.version);
    const notifications = page ? optionalNotifications(page) : undefined;
    return {
      signedIn: true,
      accountId,
      preferences,
      ...(page && notifications ? { notifications, page } : {}),
      securityHref: securityHref(sessionEnv),
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (isSessionUnavailableError(error)) throw error;
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
      const preferences = present(result.data);
      const page = preferences ? currentPageFrom(result.data, preferences.version, true) : undefined;
      const notifications = page ? optionalNotifications(page) : undefined;
      if (!notifications || !preferences || !page)
        return {
          ok: false,
          reason: 'unavailable',
          failure: failureDetails(result.data, result.status, result.headers),
        };
      return { ok: true, notifications, version: preferences.version, page };
    }
    const failure = failureDetails(result.error, statusOf(result), result.headers);
    const refused = writeFailure(failure);
    const page = failure.status === 409 && failure.code === 'conflict' ? conflictPageFrom(result.error) : undefined;
    return page ? { ...refused, page } : refused;
  } catch (error) {
    const failure = failureDetails(error);
    if (error instanceof MediaProblem && error.problem.code === 'forbidden')
      return { ok: false, reason: 'forbidden', failure };
    if (isPlatformClosedError(error) || failure.code === 'platform_closed')
      return { ok: false, reason: 'closed', failure };
    return writeFailure(failure);
  }
}

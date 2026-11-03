import {
  collectionPresentationOf,
  type CollectionPresentationData,
  type CollectionTypeOption,
  type CollectionListPresentations,
} from './collection-presentation';
import { notFound } from '@tanstack/react-router';
import type { KernelClient } from '@rezics/client';
import type { SessionEnv } from '../session/client';
import type { ReadCredentialMode } from '../kernel/credential';
import type { FilterDocument } from '@rezics/filter';
import type { CollectionFilterProperty } from './collection-filters';
import type { CollectionFilterParams } from './collection-filter-params';
import { collectionFilterQuery } from './collection-filter-params';
import { getLocale } from '../paraglide/runtime.js';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { readCollectionFollow, readCollectionViewerActions, type CollectionViewerActions } from './collection-records';
import {
  libraryFullQuery,
  libraryListQuery,
  readLibraryResult,
  StaleCursorError,
  subjectOf,
  type CollectionPageData,
  type LibraryAccount,
} from './reads';
import {
  dynamicCollectionTitle,
  type CuratedCollectionRead,
  type DynamicCollectionPage,
  type DynamicCollectionRead,
  type DynamicMembersPage,
} from './dynamic-collection';

export type CollectionReadAddress = {
  id: string;
  cursor?: string | undefined;
  editor?: boolean | undefined;
  search?: Record<string, string | string[]> | undefined;
  filter?: FilterDocument | undefined;
};

/** Nonsecret evidence of the prepared server viewer and the exact addressed read. */
type NativeCollection = NonNullable<
  Awaited<ReturnType<ReturnType<KernelClient['collections']>['get']>>['data']
>['collection'];
type LogicalBuiltinIdentity = Pick<
  Extract<NativeCollection, { builtin: unknown }>,
  'id' | 'curatorAccountId' | 'builtin'
>;
export type CollectionReadProvenance = {
  mode: ReadCredentialMode;
  viewerId: string | null;
  request: string;
  /** Only an actual native logical descriptor can supply a revision-zero identity. */
  logicalBuiltin?: LogicalBuiltinIdentity;
};

export function collectionRequestVariant(input: CollectionReadAddress, kind: 'page' | 'members' = 'page'): string {
  return JSON.stringify([
    kind,
    input.id,
    input.cursor || null,
    input.editor === true,
    Object.entries(input.search ?? {}).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    input.filter ?? null,
  ]);
}

// Optional at the presentation boundary for existing public recordings. Private consumers require it at runtime.
type CollectionReadResult = { provenance?: CollectionReadProvenance };
export type CollectionPageResult = (EditableCollectionPage | DynamicCollectionPage) & CollectionReadResult;
export type DynamicMembersResult = Pick<
  DynamicCollectionPage,
  'members' | 'next' | 'preparing' | 'retryAfterMs' | 'unavailable' | 'cursorRestarted'
> & { filterStatus?: DynamicCollectionPage['filterStatus'] } & CollectionReadResult;

export function collectionResultMatches(
  result: CollectionReadResult & { id?: string },
  input: CollectionReadAddress,
  mode: ReadCredentialMode,
  viewerId: string | null,
  kind: 'page' | 'members' = 'page',
): boolean {
  const provenance = result.provenance;
  return (
    (mode === 'anonymous' ? viewerId === null : typeof viewerId === 'string' && viewerId.length > 0) &&
    provenance?.mode === mode &&
    provenance.viewerId === viewerId &&
    provenance.request === collectionRequestVariant(input, kind) &&
    (kind === 'members' || result.id === input.id)
  );
}
type CuratedMemberPage = {
  members: {
    id: string;
    note: string | null;
    addedAt: string;
    facts?: CollectionPageData['members'][number]['facts'];
    subject?: Parameters<typeof subjectOf>[0] | null;
  }[];
  next: string | null;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function resultStatus(value: unknown): number | undefined {
  const result = record(value);
  const error = record(result.error);
  const response = record(result.response);
  const errorResponse = record(error.response);
  return typeof result.status === 'number'
    ? result.status
    : typeof error.status === 'number'
      ? error.status
      : typeof response.status === 'number'
        ? response.status
        : typeof errorResponse.status === 'number'
          ? errorResponse.status
          : undefined;
}

function isStaleCursorResult(value: unknown): boolean {
  const error = record(record(value).error);
  const problem = record(error.value);
  return resultStatus(value) === 409 && (problem.code === 'stale_cursor' || error.code === 'stale_cursor');
}

function retryAfterMs(value: unknown): number {
  const result = record(value);
  const error = record(result.error);
  const response = record(result.response);
  const errorResponse = record(error.response);
  const headers = [result.headers, response.headers, error.headers, errorResponse.headers];
  let raw: string | null = null;
  for (const candidate of headers) {
    const headerBag = record(candidate);
    const get = headerBag.get;
    if (typeof get === 'function') {
      raw = (get as (this: unknown, name: string) => string | null).call(candidate, 'retry-after');
      if (raw !== null) break;
    }
  }
  if (raw === null) return 1000;
  const seconds = Number(raw);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
  return Math.max(1000, Math.min(30_000, Number.isFinite(delay) ? delay : 1000));
}

function generatedClientDTO<Value>(value: unknown): Value {
  // @rezics/client still generates curated-only Collection types; remove this cast when its dynamic DTO lands.
  return value as Value;
}

/** Capture the addressed Source/filter once; status retries only supply the same opaque cursor.
 * Each request still goes through the generated client and its current credential/disclosure transport.
 */
function collectionMembersReader(
  client: KernelClient,
  id: string,
  headers: { headers: { authorization: string } } | Record<string, never>,
  filter?: FilterDocument,
) {
  const filterQuery = collectionFilterQuery(filter);
  return async (cursor?: string): Promise<unknown> => {
    try {
      return await client.collections({ collectionId: id }).members.get({
        query: { ...libraryListQuery(cursor), ...filterQuery } as never,
        ...headers,
      });
    } catch (error) {
      if (![202, 400, 409, 422, 503].includes(resultStatus(error) ?? 0)) throw error;
      return error;
    }
  };
}

export async function loadDynamicMembers(
  client: KernelClient,
  id: string,
  cursor?: string,
  headers: { headers: { authorization: string } } | Record<string, never> = {},
  filter?: FilterDocument,
): Promise<DynamicMembersResult> {
  const result = await collectionMembersReader(client, id, headers, filter)(cursor);
  const status = resultStatus(result);
  if (filter && (status === 400 || status === 422)) {
    return {
      members: [],
      next: null,
      preparing: false,
      retryAfterMs: 1000,
      unavailable: false,
      filterStatus: 'unsupported',
    };
  }
  const finalStatus = resultStatus(result);
  if (finalStatus === 202)
    return {
      members: [],
      next: null,
      preparing: true,
      retryAfterMs: retryAfterMs(result),
      unavailable: false,
      filterStatus: filter ? 'preparing' : undefined,
    };
  if (finalStatus === 503)
    return {
      members: [],
      next: null,
      preparing: false,
      retryAfterMs: 1000,
      unavailable: true,
      filterStatus: undefined,
    };
  const page = generatedClientDTO<DynamicMembersPage>(
    readLibraryResult(result as Parameters<typeof readLibraryResult>[0]),
  );
  return {
    members: page.members.map((member) => ({
      subject: subjectOf(member.subject as Parameters<typeof subjectOf>[0]),
      ...(member.subject && member.facts !== undefined ? { facts: member.facts } : {}),
    })),
    next: page.next,
    preparing: false,
    retryAfterMs: 1000,
    unavailable: false,
    // Results are merged into the retained page; omission would retain an old preparing marker.
    filterStatus: undefined,
  };
}

export type EditableCollectionPage = Omit<CollectionPageData, 'memberCount'> &
  CollectionPresentationData & {
    coverMediaId?: string | null;
    presentationTypes?: CollectionTypeOption[] | null;
    listPresentations?: CollectionListPresentations;
    viewerActions?: CollectionViewerActions;
    memberState?: 'ready' | 'preparing' | 'unavailable' | 'failed';
    retryAfterMs?: number;
    filteredMembers?: DynamicCollectionPage['members'];
    /** An authorized known total; null when the current viewer's read cannot disclose one. */
    memberCount: number | null;
    /** The requested page, retained for its indexing policy. */
    cursor?: string;
    /** The revision the page was read at; a revisioned write sends it back. */
    revision: number;
    /** The first member page, where a member can move to the top. */
    firstPage: boolean;
    /** The viewer's follow state, or null when the viewer cannot follow this collection. */
    following: boolean | null;
    filterActive?: boolean;
    filter?: FilterDocument;
    filterIgnored?: string[];
    filterType?: string;
    filterStatus?: 'unsupported' | 'preparing' | 'failed' | undefined;
    filterProperties?: CollectionFilterProperty[];
    filterParams?: CollectionFilterParams;
    filterReleaseKey?: string;
    /** Whether the visible first member page can be exported as a complete public ItemList. */
    publicExport: boolean;
    typeRatios?: Record<string, string>;
    /** Public visibility can be shown without granting owner controls. */
    disclosedVisibility?: 'public' | 'unlisted';
  };

export type CollectionPolicyPage = Partial<
  Pick<
    EditableCollectionPage,
    | 'memberState'
    | 'visibility'
    | 'disclosedVisibility'
    | 'cursor'
    | 'filterActive'
    | 'filter'
    | 'filterStatus'
    | 'filterIgnored'
    | 'publicExport'
    | 'firstPage'
    | 'next'
  >
> & { preparing?: boolean };

/** The native disclosure result, request variant and readiness jointly select HTTP/head policy. */
export function collectionRenderPolicy(page: CollectionPolicyPage, laterPage = false) {
  const indexable =
    !('preparing' in page) &&
    page.memberState === 'ready' &&
    page.visibility === null &&
    page.disclosedVisibility === 'public' &&
    !laterPage &&
    page.cursor === undefined &&
    !page.filterActive &&
    page.filter === undefined &&
    !page.filterStatus &&
    !page.filterIgnored?.length;
  return {
    cache: indexable ? ('public' as const) : ('private' as const),
    indexable,
    completeItemList: indexable && page.publicExport === true && page.firstPage === true && page.next === null,
  };
}

function accountOf(account: { handle: string | null; displayName: string | null } | null | undefined) {
  return account
    ? ({
        handle: account.handle,
        displayName: account.displayName,
      } satisfies LibraryAccount)
    : null;
}

/**
 * Reads one collection and one members page, with the viewer's credential when there is one so a curator sees their
 * private collection. Public membership always uses the anonymous population outside the explicit editor read.
 * A stale cursor restarts once. Signed-in reads also load native resource actions and, for non-curators, follow state.
 */
export async function loadEditableCollectionPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: {
    id: string;
    editor?: boolean;
    cursor?: string;
    search?: Record<string, string | string[]>;
    filter?: FilterDocument;
    filterIgnored?: string[];
    filterType?: string;
    filterProperties?: CollectionFilterProperty[];
    filterParams?: CollectionFilterParams;
    filterReleaseKey?: string;
    filterStatus?: EditableCollectionPage['filterStatus'];
  },
  credentialMode: ReadCredentialMode = 'session',
): Promise<CollectionPageResult> {
  // A pending read must retain the original address even if its caller edits the input while awaiting I/O.
  input = structuredClone(input);
  let authorization: string | null = null;
  if (credentialMode === 'session') {
    const signedOut = await prepareSession(request, sessionEnv);
    authorization = signedOut ? null : viewerCredential(request);
  }
  const viewer = authorization ? sessionSubject(request) : undefined;
  // Explicit Authorization is transport, not evidence of a prepared browser subject.
  if (credentialMode === 'session' && (!authorization || !viewer)) throw notFound();
  const provenance: CollectionReadProvenance = {
    mode: credentialMode,
    viewerId: viewer ?? null,
    request: collectionRequestVariant(input),
  };
  const headers = authorization ? { headers: { authorization } } : {};
  const collectionResult = await client.collections({ collectionId: input.id }).get({
    query: libraryFullQuery(),
    ...headers,
  });
  const collectionEnvelope = readLibraryResult(collectionResult);
  // Keep the existing dynamic compatibility boundary; no new Source operation is called here.
  const collection = generatedClientDTO<CuratedCollectionRead | DynamicCollectionRead>(collectionEnvelope.collection);
  if (collection.id !== input.id) throw notFound();
  const nativeCollection = collectionEnvelope.collection;
  if ('builtin' in nativeCollection && nativeCollection.revision === 0) {
    provenance.logicalBuiltin = {
      id: nativeCollection.id,
      curatorAccountId: nativeCollection.curatorAccountId,
      builtin: structuredClone(nativeCollection.builtin),
    };
  }
  // Unfiltered public browsing uses the anonymous member/facet population.
  const publicMembership = 'visibility' in collection && collection.visibility !== 'private';
  const editor =
    input.editor === true &&
    credentialMode === 'session' &&
    viewer !== undefined &&
    'curatorAccountId' in collection &&
    viewer === collection.curatorAccountId;
  if (input.editor && !editor) throw notFound();
  const ownerFilter = Boolean(
    input.filter && viewer && 'curatorAccountId' in collection && viewer === collection.curatorAccountId,
  );
  const memberHeaders = publicMembership && !editor && !ownerFilter ? {} : headers;
  const filterState: { status: EditableCollectionPage['filterStatus'] } = {
    status: input.filterStatus === 'preparing' ? undefined : input.filterStatus,
  };
  const readAddress = collectionMembersReader(client, input.id, memberHeaders, input.filter);
  const readMembers = async (cursor?: string) => {
    if (filterState.status === 'failed') return { status: 200, data: { members: [], next: null } };
    let result: unknown;
    try {
      result = await readAddress(cursor);
    } catch (error) {
      const status = resultStatus(error);
      // Keep the authorized Collection shell when only its Members read failed.
      // Credentials and concealment errors still propagate through the route boundary.
      if (status === undefined || status >= 500) return { status: status ?? 500 };
      throw error;
    }
    const status = resultStatus(result);
    if (input.filter && (status === 400 || status === 422)) {
      filterState.status = 'unsupported';
      return { status: 200, data: { members: [], next: null } };
    }
    if (input.filter && status === 202) filterState.status = 'preparing';
    return result;
  };
  const [first, viewerActions] = await Promise.all([
    readMembers(input.cursor).then(
      (page) => (isStaleCursorResult(page) ? { stale: true as const } : { stale: false as const, page }),
      (error: unknown) => {
        if (error instanceof StaleCursorError || isStaleCursorResult(error)) return { stale: true as const };
        if (resultStatus(error) === 202 || resultStatus(error) === 503) return { stale: false as const, page: error };
        throw error;
      },
    ),
    authorization ? readCollectionViewerActions(client, input.id, authorization) : undefined,
  ]);
  const membersResult = first.stale ? await readMembers() : first.page;
  const filterStatus = filterState.status;
  const cursorRestarted = first.stale;
  if (collection.membershipKind === 'dynamic') {
    const following = authorization ? await readCollectionFollow(client, collection.id, authorization) : null;
    const filterFields = {
      provenance,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...collectionPresentationOf(collectionEnvelope.collection),
      ...(collection.revision === undefined ? {} : { revision: collection.revision }),
      ...(collection.curatorAccountId === undefined ? {} : { curatorAccountId: collection.curatorAccountId }),
      ...(viewer !== undefined && viewer === collection.curatorAccountId && 'visibility' in collection
        ? { visibility: collection.visibility }
        : {}),
      ...(authorization && viewerActions ? { viewerActions } : {}),
      ...(input.filter ? { filter: input.filter } : {}),
      ...(input.filterIgnored ? { filterIgnored: input.filterIgnored } : {}),
      ...(input.filterType ? { filterType: input.filterType } : {}),
      ...(filterStatus ? { filterStatus } : {}),
      ...(input.filterProperties ? { filterProperties: input.filterProperties } : {}),
      ...(input.filterParams ? { filterParams: input.filterParams } : {}),
      ...(input.filterReleaseKey ? { filterReleaseKey: input.filterReleaseKey } : {}),
      following,
      ...(cursorRestarted ? { cursorRestarted: true as const } : {}),
    };
    const status = resultStatus(membersResult);
    if (status === 202) {
      return {
        id: collection.id,
        title: dynamicCollectionTitle(collection, getLocale()),
        builtinKind: collection.builtinKind,
        description: collection.description ?? null,
        curator: accountOf(collection.curator),
        members: [],
        next: null,
        preparing: true,
        retryAfterMs: retryAfterMs(membersResult),
        unavailable: false,
        ...filterFields,
      };
    }
    if (status === 503) {
      return {
        id: collection.id,
        title: dynamicCollectionTitle(collection, getLocale()),
        builtinKind: collection.builtinKind,
        description: collection.description ?? null,
        curator: accountOf(collection.curator),
        members: [],
        next: null,
        preparing: false,
        retryAfterMs: 1000,
        unavailable: true,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...filterFields,
      };
    }
    const page = generatedClientDTO<DynamicMembersPage>(
      readLibraryResult(membersResult as Parameters<typeof readLibraryResult>[0]),
    );
    const dynamicMembers = {
      members: page.members.map((member) => ({
        ...(editor && member.subject ? { subjectId: member.subjectId } : {}),
        subject: subjectOf(member.subject as Parameters<typeof subjectOf>[0]),
        ...(member.subject && member.facts !== undefined ? { facts: member.facts } : {}),
      })),
      next: page.next,
      preparing: false,
      retryAfterMs: 1000,
      unavailable: false,
    };
    return {
      id: collection.id,
      title: dynamicCollectionTitle(collection, getLocale()),
      builtinKind: collection.builtinKind,
      description: collection.description ?? null,
      curator: accountOf(collection.curator),
      ...dynamicMembers,
      ...filterFields,
    };
  }
  const curatedCollection = collection as CuratedCollectionRead;
  const memberStatus = resultStatus(membersResult);
  const memberState =
    memberStatus === 202
      ? 'preparing'
      : memberStatus === 503
        ? 'unavailable'
        : memberStatus !== undefined && memberStatus >= 500
          ? 'failed'
          : 'ready';
  const members =
    memberState === 'ready'
      ? generatedClientDTO<CuratedMemberPage>(
          readLibraryResult(membersResult as Parameters<typeof readLibraryResult>[0]),
        )
      : { members: [], next: null };
  const canonical = input.filter
    ? generatedClientDTO<DynamicMembersPage>(
        memberState === 'ready'
          ? readLibraryResult(membersResult as Parameters<typeof readLibraryResult>[0])
          : { members: [], next: null },
      )
    : null;
  const owner = viewer !== undefined && viewer === curatedCollection.curatorAccountId;
  const following =
    authorization && !owner && curatedCollection.visibility !== 'private'
      ? await readCollectionFollow(client, input.id, authorization)
      : null;
  const visibleMembers =
    owner && (!publicMembership || editor)
      ? members.members
      : members.members.filter((member) => member.subject != null);
  const memberCount =
    memberState !== 'ready' || filterStatus || input.filter
      ? null
      : owner
        ? typeof curatedCollection.memberCount === 'number' &&
          Number.isSafeInteger(curatedCollection.memberCount) &&
          curatedCollection.memberCount >= 0
          ? curatedCollection.memberCount
          : null
        : !input.filter &&
            !filterStatus &&
            !input.filterIgnored?.length &&
            (first.stale || input.cursor === undefined) &&
            members.next === null
          ? visibleMembers.length
          : null;
  return {
    provenance,
    ...collectionPresentationOf(collectionEnvelope.collection),
    ...(owner &&
    'coverMediaId' in collectionEnvelope.collection &&
    collectionEnvelope.collection.coverMediaId !== undefined
      ? { coverMediaId: collectionEnvelope.collection.coverMediaId }
      : {}),
    id: curatedCollection.id,
    title: curatedCollection.title,
    description: curatedCollection.description,
    memberCount,
    updatedAt: curatedCollection.updatedAt,
    curator: accountOf(curatedCollection.curator),
    visibility: owner ? curatedCollection.visibility : null,
    ...(!owner && curatedCollection.visibility !== 'private'
      ? { disclosedVisibility: curatedCollection.visibility }
      : {}),
    members: (canonical ? [] : visibleMembers).map((member) => ({
      id: member.id,
      note: member.note,
      addedAt: member.addedAt,
      subject: subjectOf(member.subject),
      ...(member.subject && member.facts !== undefined ? { facts: member.facts } : {}),
    })),
    ...(canonical
      ? {
          filteredMembers: canonical.members.map((member) => ({
            subject: subjectOf(member.subject as Parameters<typeof subjectOf>[0]),
            ...(member.subject && member.facts !== undefined ? { facts: member.facts } : {}),
          })),
        }
      : {}),
    next: canonical?.next ?? members.next,
    revision: collection.revision,
    firstPage: first.stale || input.cursor === undefined,
    following,
    ...(viewerActions ? { viewerActions } : {}),
    memberState,
    ...(memberState === 'preparing' ? { retryAfterMs: retryAfterMs(membersResult) } : {}),
    ...(input.filter ? { filter: input.filter } : {}),
    ...(input.filterIgnored ? { filterIgnored: input.filterIgnored } : {}),
    ...(input.filterType ? { filterType: input.filterType } : {}),
    ...(filterStatus ? { filterStatus } : {}),
    ...(input.filterProperties ? { filterProperties: input.filterProperties } : {}),
    ...(input.filterParams ? { filterParams: input.filterParams } : {}),
    ...(input.filterReleaseKey ? { filterReleaseKey: input.filterReleaseKey } : {}),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    publicExport:
      memberState === 'ready' &&
      credentialMode === 'anonymous' &&
      curatedCollection.visibility === 'public' &&
      input.cursor === undefined &&
      !input.filter &&
      !filterStatus &&
      !input.filterIgnored?.length &&
      members.next === null,
  };
}

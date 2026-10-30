import type { KernelClient } from '@rezics/client';
import type { SessionEnv } from '../session/client';
import type { ReadCredentialMode } from '../kernel/credential';
import type { FilterDocument } from '@rezics/filter';
import type { CollectionFilterProperty } from './collection-filters';
import type { CollectionFilterParams } from './collection-filter-params';
import { collectionFilterQuery } from './collection-filter-params';
import { getLocale } from '../paraglide/runtime.js';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { readCollectionFollow } from './collection-records';
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

export type CollectionPageResult = EditableCollectionPage | DynamicCollectionPage;
export type DynamicMembersResult = Pick<
  DynamicCollectionPage,
  'members' | 'next' | 'preparing' | 'retryAfterMs' | 'unavailable'
> &
  Pick<DynamicCollectionPage, 'filterStatus'>;
type CuratedMemberPage = {
  members: {
    id: string;
    note: string | null;
    addedAt: string;
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

export async function loadDynamicMembers(
  client: KernelClient,
  id: string,
  cursor?: string,
  headers: { headers: { authorization: string } } | Record<string, never> = {},
  filter?: FilterDocument,
): Promise<DynamicMembersResult> {
  let result: unknown;
  try {
    result = await client
      .collections({ collectionId: id })
      .members.get({ query: { ...libraryListQuery(cursor), ...collectionFilterQuery(filter) } as never, ...headers });
  } catch (error) {
    if (resultStatus(error) !== 202 && resultStatus(error) !== 503) throw error;
    result = error;
  }
  const status = resultStatus(result);
  let filterStatus: DynamicCollectionPage['filterStatus'];
  if (filter && (status === 400 || status === 422)) {
    filterStatus = 'unsupported';
    result = await client
      .collections({ collectionId: id })
      .members.get({ query: libraryListQuery(cursor), ...headers });
  }
  const finalStatus = resultStatus(result);
  if (finalStatus === 202)
    return { members: [], next: null, preparing: true, retryAfterMs: retryAfterMs(result), unavailable: false };
  if (finalStatus === 503) return { members: [], next: null, preparing: false, retryAfterMs: 1000, unavailable: true };
  const page = generatedClientDTO<DynamicMembersPage>(
    readLibraryResult(result as Parameters<typeof readLibraryResult>[0]),
  );
  return {
    members: page.members.map((member) => ({ subject: subjectOf(member.subject as Parameters<typeof subjectOf>[0]) })),
    next: page.next,
    preparing: false,
    retryAfterMs: 1000,
    unavailable: false,
    ...(filterStatus ? { filterStatus } : {}),
  };
}

export type EditableCollectionPage = CollectionPageData & {
  /** The requested page, retained for its indexing policy. */
  cursor?: string;
  /** The revision the page was read at; a revisioned write sends it back. */
  revision: number;
  /** The first member page, where a member can move to the top. */
  firstPage: boolean;
  /** The viewer's follow state, or null when the viewer cannot follow this collection. */
  following: boolean | null;
  filter?: FilterDocument;
  filterIgnored?: string[];
  filterType?: string;
  filterStatus?: 'unsupported' | 'preparing' | 'failed';
  filterProperties?: CollectionFilterProperty[];
  filterParams?: CollectionFilterParams;
};

function accountOf(account: { handle: string | null; displayName: string | null } | null | undefined) {
  return account ? ({ handle: account.handle, displayName: account.displayName } satisfies LibraryAccount) : null;
}

/**
 * Reads one collection and one members page, with the viewer's credential when there is one so a curator sees their
 * private collection. A cursor the kernel no longer accepts restarts at the first page. A signed-in person who is not
 * the curator of a public collection also gets the follow state, in one more kernel read.
 */
export async function loadEditableCollectionPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: {
    id: string;
    cursor?: string;
    filter?: FilterDocument;
    filterIgnored?: string[];
    filterType?: string;
    filterProperties?: CollectionFilterProperty[];
    filterParams?: CollectionFilterParams;
  },
  credentialMode: ReadCredentialMode = 'session',
): Promise<CollectionPageResult> {
  let authorization: string | null = null;
  if (credentialMode === 'session') {
    // A session that cannot be read leaves the collection readable to everyone.
    const signedOut = await prepareSession(request, sessionEnv).then(
      (stale) => stale,
      () => true,
    );
    authorization = signedOut ? null : viewerCredential(request);
  }
  const viewer = authorization ? sessionSubject(request) : undefined;
  const headers = authorization ? { headers: { authorization } } : {};
  let filterStatus: EditableCollectionPage['filterStatus'];
  const readMembers = async (cursor?: string, filter = input.filter) => {
    const query = { ...libraryListQuery(cursor), ...collectionFilterQuery(filter) };
    for (let retry = 0; ; retry++) {
      let result: unknown;
      try {
        result = await client
          .collections({ collectionId: input.id })
          .members.get({ query: query as never, ...headers });
      } catch (error) {
        result = error;
      }
      const status = resultStatus(result);
      if (filter && (status === 400 || status === 422)) {
        filterStatus = 'unsupported';
        return client
          .collections({ collectionId: input.id })
          .members.get({ query: libraryListQuery(cursor), ...headers });
      }
      if (filter && status === 202) {
        if (retry >= 3) {
          filterStatus = 'preparing';
          return { status: 200, data: { members: [], next: null } };
        }
        const delay = retryAfterMs(result) || 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      return result;
    }
  };
  const [collectionResult, first] = await Promise.all([
    client.collections({ collectionId: input.id }).get({ query: libraryFullQuery(), ...headers }),
    readMembers(input.cursor).then(
      (page) => (isStaleCursorResult(page) ? { stale: true as const } : { stale: false as const, page }),
      (error: unknown) => {
        if (error instanceof StaleCursorError) return { stale: true as const };
        if (resultStatus(error) === 202 || resultStatus(error) === 503) return { stale: false as const, page: error };
        throw error;
      },
    ),
  ]);
  const membersResult = first.stale ? await readMembers() : first.page;
  const collectionEnvelope = readLibraryResult(collectionResult);
  // One boundary cast carries the documented union until the generated client supports it.
  const collection = generatedClientDTO<CuratedCollectionRead | DynamicCollectionRead>(collectionEnvelope.collection);
  if (collection.membershipKind === 'dynamic') {
    const filterFields = {
      ...(input.filter ? { filter: input.filter } : {}),
      ...(input.filterIgnored ? { filterIgnored: input.filterIgnored } : {}),
      ...(input.filterType ? { filterType: input.filterType } : {}),
      ...(filterStatus ? { filterStatus } : {}),
      ...(input.filterProperties ? { filterProperties: input.filterProperties } : {}),
      ...(input.filterParams ? { filterParams: input.filterParams } : {}),
    };
    if (filterStatus === 'preparing') {
      return {
        id: collection.id,
        title: dynamicCollectionTitle(collection, getLocale()),
        builtinKind: collection.builtinKind,
        description: collection.description ?? null,
        curator: accountOf(collection.curator),
        members: [],
        next: null,
        preparing: true,
        retryAfterMs: 1000,
        unavailable: false,
        ...filterFields,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      };
    }
    const status = first.stale ? 200 : resultStatus(membersResult);
    if (!first.stale && status === 202) {
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
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...filterFields,
      };
    }
    if (!first.stale && status === 503) {
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
        subject: subjectOf(member.subject as Parameters<typeof subjectOf>[0]),
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
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...filterFields,
    };
  }
  const curatedCollection = collection as CuratedCollectionRead;
  const members = generatedClientDTO<CuratedMemberPage>(
    readLibraryResult(membersResult as Parameters<typeof readLibraryResult>[0]),
  );
  const owner = viewer !== undefined && viewer === curatedCollection.curatorAccountId;
  const following =
    authorization && viewer !== undefined && !owner && curatedCollection.visibility === 'public'
      ? await readCollectionFollow(client, input.id, authorization)
      : null;
  return {
    id: curatedCollection.id,
    title: curatedCollection.title,
    description: curatedCollection.description,
    memberCount: curatedCollection.memberCount,
    updatedAt: curatedCollection.updatedAt,
    curator: accountOf(curatedCollection.curator),
    visibility: owner ? curatedCollection.visibility : null,
    members: members.members.map((member) => ({
      id: member.id,
      note: member.note,
      addedAt: member.addedAt,
      subject: subjectOf(member.subject),
    })),
    next: members.next,
    revision: collection.revision,
    firstPage: first.stale || input.cursor === undefined,
    following,
    ...(input.filter ? { filter: input.filter } : {}),
    ...(input.filterIgnored ? { filterIgnored: input.filterIgnored } : {}),
    ...(input.filterType ? { filterType: input.filterType } : {}),
    ...(filterStatus ? { filterStatus } : {}),
    ...(input.filterProperties ? { filterProperties: input.filterProperties } : {}),
    ...(input.filterParams ? { filterParams: input.filterParams } : {}),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  };
}

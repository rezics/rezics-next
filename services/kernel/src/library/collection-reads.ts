import type { Pool, PoolClient } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import { commandAccessContext } from '../access/command-admission.ts';
import type { AuthoritativeTime, CommandAttempt } from '../command/command.ts';
import { readAccount, type Account } from '../access/account-data.ts';
import { readPublicViews } from '../access/index.ts';
import { createResourcePublicEligibility } from '../access/public-eligibility.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Access, type AccountActor, type Actor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding, type CursorKey } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { subjectCollections } from './listing.ts';
import { isOrdinalKey } from './ordinal.ts';
import { WORK_STEP_DEADLINE_MS } from './command-support.ts';
import { readableSubjects, resolveSubject } from './subject-anchor.ts';
import collectionRead from './collection-reads-collection.sql';
import curatorPublicPage from './collection-reads-curator-public.sql';
import curatorPage from './collection-reads-curator.sql';
import memberPage from './collection-reads-members.sql';
import listingCounts from './listing-counts.sql';

type CuratorPageOptions = { curatorAccountId: string; cursor?: string | null; limit?: number };

type QueryClient = Pick<PoolClient, 'query'>;
type StoredCollection = NonNullable<Awaited<ReturnType<typeof collectionRead.run>>>;
type MemberRow = Awaited<ReturnType<typeof memberPage.run>>[number];
type Sink = { seen: boolean; row: StoredCollection | null; failure?: { error: unknown } };
export type CollectionView = {
  id: string;
  curatorAccountId: string;
  title: string;
  description: string | null;
  visibility: 'private' | 'unlisted' | 'public';
  revision: number;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
};

export type MemberView = {
  id: string;
  subjectId: string;
  note: string | null;
  addedAt: string;
};

export type PublicCollectionView = {
  id: string;
  curatorAccountId: string;
  title: string;
  multiplicity: number;
};

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_CURSOR_LENGTH = 4096;
const ABSENT_UPDATED_AT = '9999-12-31T23:59:59.999999Z';
const ABSENT_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const UPDATED_AT_EXACT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function notFound(): ProblemError {
  return new ProblemError('not_found');
}

function invalidCursor(): ProblemError {
  return new ProblemError('invalid_cursor');
}

function queryOf(client: QueryClient): QueryClient {
  return { query: client.query.bind(client) };
}

function iso(value: string): string {
  return new Date(value).toISOString();
}

function collectionView(row: {
  id: string;
  curatorAccountId: string;
  title: string;
  description: string | null;
  visibility: string;
  revision: number;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}): CollectionView {
  if (row.visibility !== 'private' && row.visibility !== 'unlisted' && row.visibility !== 'public') throw notFound();
  return {
    id: row.id,
    curatorAccountId: row.curatorAccountId,
    title: row.title,
    description: row.description,
    visibility: row.visibility,
    revision: row.revision,
    memberCount: row.memberCount,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function memberView(row: MemberRow): MemberView {
  return { id: row.id, subjectId: row.subjectId, note: row.note, addedAt: iso(row.addedAt) };
}

function actor(viewer: Actor): viewer is AccountActor {
  return viewer.kind === 'account';
}

/** Live account authority for a private Collection. A token cached before suspension is not enough. */
export function grantCapable(
  account: Pick<Account, 'route' | 'accountId' | 'kind' | 'state' | 'fenced' | 'minimumAuthnEpoch'>,
  viewer: AccountActor,
): boolean {
  const route = routeOf(viewer.accountId);
  return (
    route !== null &&
    account.route === route &&
    account.accountId === viewer.accountId &&
    account.kind === 'actor' &&
    account.state === 'active' &&
    account.fenced === false &&
    Number.isSafeInteger(viewer.authnEpoch) &&
    viewer.authnEpoch > 0 &&
    BigInt(viewer.authnEpoch) >= account.minimumAuthnEpoch &&
    viewer.scopes.includes('collection:read')
  );
}

function disclose(
  row: StoredCollection | null,
  allowed: boolean,
  account: Account | null,
  viewer: Actor,
): StoredCollection | null {
  if (!row || row.state !== 'active') return null;
  if (row.visibility === 'public' || row.visibility === 'unlisted') return allowed ? row : null;
  if (!allowed || !actor(viewer) || account === null || !grantCapable(account, viewer)) return null;
  return row;
}

function pageRequest(options: unknown, allowed: readonly string[]): { limit: number; cursor: unknown } {
  if (typeof options !== 'object' || options === null || Array.isArray(options))
    throw new TypeError('Page options must be an object');
  const record = options as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new TypeError('Page options contain an unknown field');
  }
  const limit = record.limit === undefined ? DEFAULT_PAGE_SIZE : record.limit;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE)
    throw new RangeError(`Page limit must be an integer from 1 to ${MAX_PAGE_SIZE}`);
  return { limit, cursor: record.cursor };
}

function cursorToken(cursor: unknown): string | null {
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) throw invalidCursor();
  return cursor;
}

async function readOnly<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

function readEligibility(route: number, id: string, sink: Sink) {
  const resource = Object.freeze({ route, id });
  return createResourcePublicEligibility({
    resource,
    action: 'collection:read',
    async prepare() {
      return { ready: true };
    },
    // False leaves the owner's grant path intact. A throw would hide a private Collection from its curator.
    async verify({ client }) {
      try {
        const row = await collectionRead.run(queryOf(client), { route, id });
        sink.seen = true;
        sink.row = row;
        return row !== null && row.state === 'active' && row.visibility !== 'private';
      } catch (error) {
        // Access fails closed on evidence errors. The owning read must still preserve an unavailable outcome.
        sink.failure = { error };
        throw error;
      }
    },
  });
}

export function createCollectionReads(dependencies: { pool: Pool; access: Access; tokens: KeyRing }) {
  const { pool, access, tokens } = dependencies;
  const anchors = { pool, access };

  return { readCollection, listCollections, listAccountCollections, listMembers, listSubjectCollections };

  async function loadCollection(
    viewer: Actor,
    id: string,
    deadline = deadlineFor(WORK_STEP_DEADLINE_MS),
    observation?: { time: AuthoritativeTime; attempt?: CommandAttempt },
  ): Promise<StoredCollection | null> {
    if (typeof id !== 'string') return null;
    const route = routeOf(id);
    if (route === null) return null;
    const sink: Sink = { seen: false, row: null };
    const check = await accessCheck(
      access,
      viewer,
      'collection:read',
      { route, id, eligibility: readEligibility(route, id, sink) },
      observation?.attempt ? commandAccessContext({ pool, deadline }, observation.attempt) : { pool, deadline },
    );
    return readOnly(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      const account =
        actor(viewer) && routeOf(viewer.accountId) !== null
          ? await readAccount(client, routeOf(viewer.accountId)!, viewer.accountId)
          : null;
      const allowed = await check(client, observation?.time);
      if (sink.failure) throw sink.failure.error;
      if (!sink.seen) sink.row = await collectionRead.run(queryOf(client), { route, id });
      return disclose(sink.row, allowed, account, viewer);
    });
  }

  async function readCollection(
    viewer: Actor,
    id: string,
    deadline?: number,
    observation?: { time: AuthoritativeTime; attempt?: CommandAttempt },
  ): Promise<CollectionView> {
    const row = await loadCollection(viewer, id, deadline, observation);
    if (!row) throw notFound();
    return collectionView(row);
  }

  async function seesAll(viewer: Actor, curatorAccountId: string): Promise<boolean> {
    if (!actor(viewer) || viewer.accountId !== curatorAccountId || !viewer.scopes.includes('collection:read'))
      return false;
    const route = routeOf(viewer.accountId);
    if (route === null) return false;
    const account = await withConnection(pool, (client) => readAccount(client, route, viewer.accountId));
    return account !== null && grantCapable(account, viewer);
  }

  function unseal(token: string | null, binding: CursorBinding): { epoch: number; after: CursorKey[] } | null {
    if (token === null) return null;
    const decoded = decodeCursor(tokens, binding, token);
    if (!decoded.ok) throw invalidCursor();
    return { epoch: decoded.epoch, after: decoded.after };
  }

  function listCollections(viewer: Actor, options: CuratorPageOptions) {
    return listCuratorPage(viewer, options, false);
  }

  /** The account's public face uses the public index even when the curator is the viewer. */
  function listAccountCollections(viewer: Actor, options: CuratorPageOptions) {
    return listCuratorPage(viewer, options, true);
  }

  async function listCuratorPage(
    viewer: Actor,
    options: CuratorPageOptions,
    publicOnly: boolean,
  ): Promise<{ collections: CollectionView[]; next: string | null }> {
    const page = pageRequest(options, ['curatorAccountId', 'cursor', 'limit']);
    if (typeof options.curatorAccountId !== 'string')
      throw new TypeError('Collection list options need a curator account id');
    const route = routeOf(options.curatorAccountId);
    if (route === null) throw notFound();
    // Presentation visibility is read before opening the page transaction. A visible account path
    // needs no private account read; only a hidden view needs the existing curator exception.
    const publicViews = await readPublicViews(pool, [options.curatorAccountId]);
    const visible = publicViews.get(options.curatorAccountId)?.collections === true;
    const curator = (!publicOnly || !visible) && (await seesAll(viewer, options.curatorAccountId));
    const fullView = !publicOnly && curator;
    const binding: CursorBinding = {
      operation: publicOnly ? 'library.account.collections' : 'library.collection.list',
      parameters: { curatorAccountId: options.curatorAccountId, fullView },
    };
    const cursor = unseal(cursorToken(page.cursor), binding);
    const after = listPosition(cursor, route);
    if (!visible && !curator) return { collections: [], next: null };
    return readOnly(pool, async (client) => {
      const partition = await readPartition(client, partitionOf(route));
      if (cursor && cursor.epoch !== partition?.epoch) {
        if (!partition) throw new ProblemError('partition_unavailable');
        throw new ProblemError('stale_cursor');
      }
      const statement = fullView ? curatorPage : curatorPublicPage;
      const rows = await statement.run(queryOf(client), {
        route,
        curator_account_id: options.curatorAccountId,
        after_updated_at: after?.updatedAt ?? ABSENT_UPDATED_AT,
        after_id: after?.id ?? ABSENT_ID,
        has_cursor: after !== null,
        limit: page.limit + 1,
      });
      const hasMore = rows.length > page.limit;
      const shown = rows.slice(0, page.limit);
      if (hasMore && !partition) throw new ProblemError('partition_unavailable');
      const last = shown.at(-1);
      const exact = last?.updatedAtExact;
      return {
        collections: shown.map(collectionView),
        next:
          hasMore && last && partition && exact
            ? encodeCursor(tokens, binding, { epoch: partition.epoch, after: [exact, last.id] })
            : null,
      };
    });
  }

  async function listMembers(
    viewer: Actor,
    collectionId: string,
    options: { cursor?: string | null; limit?: number } = {},
  ): Promise<{ members: MemberView[]; next: string | null }> {
    const page = pageRequest(options, ['cursor', 'limit']);
    const collection = await loadCollection(viewer, collectionId);
    if (!collection) throw notFound();
    const route = routeOf(collectionId)!;
    const binding: CursorBinding = { operation: 'library.collection.members', parameters: { collectionId } };
    const position = memberPosition(unseal(cursorToken(page.cursor), binding), route, collection.orderEpoch);
    const rows = await readOnly(pool, (client) =>
      memberPage.run(queryOf(client), {
        route,
        collection_id: collectionId,
        after_ordinal_key: position?.ordinalKey ?? null,
        after_member_id: position?.memberId ?? null,
        limit: page.limit + 1,
      }),
    );
    const considered = rows.slice(0, page.limit);
    const hasMore = rows.length > page.limit;
    // The extra row only decides `next`. Subject reads stay inside the page.
    const readable = new Set(
      considered.length === 0
        ? []
        : await readableSubjects(
            anchors,
            viewer,
            considered.map((row) => row.subjectId),
          ),
    );
    const last = considered.at(-1);
    return {
      members: considered.filter((row) => readable.has(row.subjectId)).map(memberView),
      next:
        hasMore && last
          ? encodeCursor(tokens, binding, {
              // Cursor epoch 0 is rejected by the seal, while a new Collection's order epoch is 0.
              epoch: collection.orderEpoch + 1,
              after: [last.ordinalKey, last.id],
            })
          : null,
    };
  }

  async function listSubjectCollections(
    viewer: Actor,
    subjectId: string,
    options: { cursor?: string | null; limit?: number } = {},
  ): Promise<{ collections: PublicCollectionView[]; count: { value: number; exact: true }; next: string | null }> {
    const page = pageRequest(options, ['cursor', 'limit']);
    if (typeof subjectId !== 'string' || (await resolveSubject(anchors, viewer, subjectId)) === null) throw notFound();
    const route = routeOf(subjectId)!;
    const counts = await listingCounts.run(pool, { partition_no: partitionOf(route), subject_ids: [subjectId] });
    const count = counts[0]?.publicCollectionCount ?? 0;
    const binding: CursorBinding = { operation: 'library.subject.collections', parameters: { subjectId } };
    const cursor = unseal(cursorToken(page.cursor), binding);
    const after = subjectPosition(cursor);
    const partition = await withConnection(pool, (client) => readPartition(client, partitionOf(route)));
    if (cursor && cursor.epoch !== partition?.epoch) {
      if (!partition) throw new ProblemError('partition_unavailable');
      throw new ProblemError('stale_cursor');
    }
    const pairs = await subjectCollections(pool, subjectId, after, page.limit + 1);
    const considered = pairs.slice(0, page.limit);
    const shown: PublicCollectionView[] = [];
    if (considered.length > 0) {
      await readOnly(pool, async (client) => {
        for (const pair of considered) {
          const row = await collectionRead.run(queryOf(client), { route: pair.collectionRoute, id: pair.collectionId });
          if (!row || row.state !== 'active' || row.visibility !== 'public') continue;
          shown.push({
            id: row.id,
            curatorAccountId: row.curatorAccountId,
            title: row.title,
            multiplicity: pair.multiplicity,
          });
        }
      });
    }
    const hasMore = pairs.length > page.limit;
    if (hasMore && !partition) throw new ProblemError('partition_unavailable');
    const last = considered.at(-1);
    return {
      collections: shown,
      count: { value: count, exact: true },
      next:
        hasMore && last && partition
          ? encodeCursor(tokens, binding, { epoch: partition.epoch, after: [last.collectionId] })
          : null,
    };
  }
}

function listPosition(
  cursor: { epoch: number; after: CursorKey[] } | null,
  route: number,
): { updatedAt: string; id: string } | null {
  if (cursor === null) return null;
  const [updatedAt, id] = cursor.after;
  if (
    cursor.after.length !== 2 ||
    typeof updatedAt !== 'string' ||
    typeof id !== 'string' ||
    !UPDATED_AT_EXACT.test(updatedAt) ||
    !Number.isFinite(Date.parse(updatedAt)) ||
    routeOf(id) !== route
  )
    throw invalidCursor();
  return { updatedAt, id };
}

function memberPosition(
  cursor: { epoch: number; after: CursorKey[] } | null,
  route: number,
  orderEpoch: number,
): { ordinalKey: string; memberId: string } | null {
  if (cursor === null) return null;
  const [ordinalKey, memberId] = cursor.after;
  if (
    cursor.after.length !== 2 ||
    typeof ordinalKey !== 'string' ||
    typeof memberId !== 'string' ||
    !isOrdinalKey(ordinalKey) ||
    routeOf(memberId) !== route
  )
    throw invalidCursor();
  if (!Number.isSafeInteger(orderEpoch) || orderEpoch < 0 || cursor.epoch !== orderEpoch + 1)
    throw new ProblemError('stale_cursor');
  return { ordinalKey, memberId };
}

function subjectPosition(cursor: { epoch: number; after: CursorKey[] } | null): string | null {
  if (cursor === null) return null;
  const [collectionId] = cursor.after;
  if (cursor.after.length !== 1 || typeof collectionId !== 'string' || routeOf(collectionId) === null)
    throw invalidCursor();
  return collectionId;
}

/** Batch form of the ordinary Collection read's public eligibility. Only the
 * requested full keys are examined; private rows remain available to Access grants. */
export const collectionViewerActionResource: import('../access/viewer-actions.ts').ViewerActionResource = {
  readAction: 'collection:read',
  async read(client, ids) {
    const result = await client.query<{ id: string; public: boolean }>(
      `SELECT row.* FROM unnest($1::integer[], $2::uuid[]) AS wanted(route,id)
       CROSS JOIN LATERAL (
         SELECT collection_id AS id, state = 'active' AND visibility <> 'private' AS public
         FROM library.collection WHERE route = wanted.route AND collection_id = wanted.id
         ORDER BY route, collection_id LIMIT 1
       ) row`,
      [ids.map((id) => routeOf(id)!), ids],
    );
    return Object.fromEntries(result.rows.map((row) => [row.id, row.public]));
  },
};

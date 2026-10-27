import type { Pool } from 'pg';
import { decodeListCursor, encodeListCursor, type ListCursorBinding } from '../tokens/list-cursor.ts';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { readRealm } from './realm.ts';
import { spaceReadEligibility } from './space.ts';
import realmsPage from './sitemap-realms-page.sql';
import newestRealmBoard from './sitemap-realm-board-newest.sql';
import spacesPage from './sitemap-spaces-page.sql';
import readSpace from './sitemap-space-read.sql';
import readSpaceRealm from './sitemap-space-realm.sql';
import readRealmSlot from './realm-space.sql';

export const COMMUNITY_SITEMAP_MAX_LIMIT = 1000;
const CANDIDATES_PER_ITEM = 4;
const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const ANONYMOUS: Actor = Object.freeze({ kind: 'anonymous' });

export type CommunitySitemapInput = { cursor?: string; limit?: number };
export type SitemapRealmItem = { id: string; lastModified: string };
export type SitemapSpaceItem = { id: string; address: string; lastModified: string };
export type CommunitySitemapPage<Item> = { items: Item[]; next: string | null };
export type CommunitySitemapDependencies = Readonly<{
  pool: Pool;
  access: Access;
  tokens: KeyRing;
  clock?: () => Date;
  cursorNow?: () => number;
}>;

type Feed = 'realms' | 'spaces';
type Position = { route: number; id: string };
type Candidate = { route: number; id: string };

/** The cursor is malformed, belongs to another feed, or has expired. */
export class InvalidCommunitySitemapCursorError extends Error {
  constructor() {
    super('Invalid community sitemap cursor');
    this.name = 'InvalidCommunitySitemapCursorError';
  }
}

function binding(feed: Feed): ListCursorBinding {
  return { route: `GET /v1/sitemap/${feed}`, viewer: null, query: {} };
}

function cursorTime(dependencies: CommunitySitemapDependencies): number {
  return (dependencies.cursorNow ?? (() => (dependencies.clock ?? (() => new Date()))().getTime()))();
}

async function positionOf(
  dependencies: CommunitySitemapDependencies,
  feed: Feed,
  cursor?: string,
): Promise<Position | null> {
  if (cursor === undefined) return null;
  try {
    const decoded = await decodeListCursor(
      dependencies.tokens,
      binding(feed),
      cursor,
      new Date(cursorTime(dependencies)),
    );
    if (!decoded.ok || decoded.epoch !== 1 || decoded.after.length !== 2) throw new Error();
    const [route, id] = decoded.after;
    if (
      typeof route !== 'number' ||
      !Number.isInteger(route) ||
      route < 0 ||
      route > 0xffff ||
      typeof id !== 'string' ||
      routeOf(id) !== route
    )
      throw new Error();
    return { route, id };
  } catch {
    throw new InvalidCommunitySitemapCursorError();
  }
}

function nextCursor(dependencies: CommunitySitemapDependencies, feed: Feed, position: Position): Promise<string> {
  return encodeListCursor(
    dependencies.tokens,
    binding(feed),
    { epoch: 1, after: [position.route, position.id] },
    new Date(cursorTime(dependencies)),
  );
}

function pageLimit(input: CommunitySitemapInput): number {
  const limit = input.limit ?? COMMUNITY_SITEMAP_MAX_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > COMMUNITY_SITEMAP_MAX_LIMIT)
    throw new RangeError(`Page limit must be 1 to ${COMMUNITY_SITEMAP_MAX_LIMIT}`);
  return limit;
}

function observedAt(dependencies: CommunitySitemapDependencies): string {
  return (dependencies.clock ?? (() => new Date()))().toISOString();
}

function comparableTimestamp(value: string): string {
  return value.replace(/(\.\d{3})Z$/, (_match, milliseconds: string) => `${milliseconds}000Z`);
}

function sitemapTimestamp(value: string): string {
  return value.replace(/(\.\d{3})000Z$/, '$1Z');
}

function candidatePosition(candidate: Candidate): Position {
  return { route: candidate.route, id: candidate.id };
}

async function candidates(
  dependencies: CommunitySitemapDependencies,
  feed: Feed,
  after: Position | null,
  limit: number,
): Promise<Candidate[]> {
  const params = { route: after?.route ?? -1, id: after?.id ?? ZERO_ID, limit };
  return withConnection(dependencies.pool, async (client) => {
    if (feed === 'realms') {
      const rows = await realmsPage.run(client, params);
      return rows.map((row) => ({ route: row.route, id: row.realm_id }));
    }
    const rows = await spacesPage.run(client, params);
    return rows.map((row) => ({ route: row.route, id: row.space_id }));
  });
}

async function listedRealm(
  dependencies: CommunitySitemapDependencies,
  deadline: number,
  candidate: Candidate,
): Promise<SitemapRealmItem | null> {
  const realm = await readRealm(dependencies, ANONYMOUS, candidate.id, { deadline });
  if (!realm || realm.state !== 'active' || realm.visibility !== 'public') return null;
  const board = await withConnection(dependencies.pool, (client) =>
    newestRealmBoard.run(client, { route: candidate.route, id: candidate.id }),
  );
  const boardAt = board?.created_at ?? null;
  const revisionAt = realm.revisionCreatedAt;
  return {
    id: candidate.id,
    lastModified:
      boardAt !== null && comparableTimestamp(boardAt) > comparableTimestamp(revisionAt) ? boardAt : revisionAt,
  };
}

async function listedSpace(
  dependencies: CommunitySitemapDependencies,
  deadline: number,
  candidate: Candidate,
  at: string,
): Promise<SitemapSpaceItem | null> {
  const resource = {
    route: candidate.route,
    id: candidate.id,
    eligibility: spaceReadEligibility({ route: candidate.route, id: candidate.id }),
  };
  const check = await accessCheck(dependencies.access, ANONYMOUS, 'space:read', resource, {
    pool: dependencies.pool,
    deadline,
  });
  return withConnection(dependencies.pool, async (client) => {
    if (!(await check(deadlineClient(client, deadline)))) return null;
    const head = await readSpace.run(client, { route: candidate.route, id: candidate.id, at });
    if (!head || head.address === null || head.revision_created_at === null) return null;
    const slot = await readRealmSlot.run(client, { route: candidate.route, space: candidate.id, at });
    const realmId = slot?.realm_id ?? null;
    if (realmId !== null) {
      const realm = await readSpaceRealm.run(client, { route: candidate.route, id: realmId, at });
      if (!realm) return null;
    }
    return { id: candidate.id, address: head.address, lastModified: sitemapTimestamp(head.revision_created_at) };
  });
}

async function list<Item extends SitemapRealmItem | SitemapSpaceItem>(
  dependencies: CommunitySitemapDependencies,
  deadline: number,
  feed: Feed,
  input: CommunitySitemapInput,
): Promise<CommunitySitemapPage<Item>> {
  const limit = pageLimit(input);
  let position = await positionOf(dependencies, feed, input.cursor);
  const rows = await candidates(dependencies, feed, position, limit * CANDIDATES_PER_ITEM);
  const items: Item[] = [];
  const at = observedAt(dependencies);
  let finished = rows.length < limit * CANDIDATES_PER_ITEM;
  for (const candidate of rows) {
    position = candidatePosition(candidate);
    const item =
      feed === 'realms'
        ? await listedRealm(dependencies, deadline, candidate)
        : await listedSpace(dependencies, deadline, candidate, at);
    if (!item) continue;
    items.push(item as Item);
    if (items.length === limit) {
      finished = false;
      break;
    }
  }
  return {
    items,
    next: finished || position === null ? null : await nextCursor(dependencies, feed, position),
  };
}

/** Public Realms are evaluated with the anonymous Realm read rule and keyset ordered by (route, id). */
export function listSitemapRealms(
  dependencies: CommunitySitemapDependencies,
  deadline: number,
  input: CommunitySitemapInput = {},
): Promise<CommunitySitemapPage<SitemapRealmItem>> {
  return list<SitemapRealmItem>(dependencies, deadline, 'realms', input);
}

/** Addressed Spaces readable to anonymous readers with no protected Realm slot. */
export function listSitemapSpaces(
  dependencies: CommunitySitemapDependencies,
  deadline: number,
  input: CommunitySitemapInput = {},
): Promise<CommunitySitemapPage<SitemapSpaceItem>> {
  return list<SitemapSpaceItem>(dependencies, deadline, 'spaces', input);
}

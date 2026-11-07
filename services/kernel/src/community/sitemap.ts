import type { Pool } from 'pg';
import { decodeListCursor, encodeListCursor, type ListCursorBinding } from '../tokens/list-cursor.ts';
import { accessCheck, deadlineClient } from './domain-ports.ts';
import type { Access, Actor } from '../request/access.ts';
import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { realmReadEligibility } from './realm-read.ts';
import { spaceReadEligibility } from './space-read.ts';
import { readSpaceAddress } from './space-address.ts';
import realmsPage from './sitemap-realms-page.sql';
import newestRealmBoard from './sitemap-realm-board-newest.sql';
import spacesPage from './sitemap-spaces-page.sql';
import readSpace from './sitemap-space-read.sql';
import readRealmHead from './sitemap-realm-read.sql';
import type { Static } from 'typebox';
import type { SitemapRealmItemSchema, SitemapSpaceItemSchema } from './schemas.ts';

export const COMMUNITY_SITEMAP_MAX_LIMIT = 1000;
const CANDIDATES_PER_ITEM = 4;
const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const ANONYMOUS: Actor = Object.freeze({ kind: 'anonymous' });

export type CommunitySitemapInput = { cursor?: string; limit?: number };
export type SitemapRealmItem = Static<ReturnType<typeof SitemapRealmItemSchema>>;
export type SitemapSpaceItem = Static<ReturnType<typeof SitemapSpaceItemSchema>>;
export type CommunitySitemapPage<Item> = { items: Item[]; next: string | null };
export type CommunitySitemapDependencies = Readonly<{
  pool: Pool;
  access: Access;
  tokens: KeyRing;
  clock: () => Date;
  cursorNow: () => number;
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
  return dependencies.cursorNow();
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
  return dependencies.clock().toISOString();
}

function comparableTimestamp(value: string): string {
  return value.replace(/(\.\d{3})Z$/, (_match, milliseconds: string) => `${milliseconds}000Z`);
}

function sitemapTimestamp(value: string): string {
  return value.replace(/(\.\d{3})000Z$/, '$1Z');
}

function latestTimestamp(...values: (string | null)[]): string {
  return values.reduce<string>(
    (latest, value) => (value !== null && comparableTimestamp(value) > comparableTimestamp(latest) ? value : latest),
    '',
  );
}

async function anonymousCheck(
  dependencies: CommunitySitemapDependencies,
  deadline: number,
  kind: 'realm' | 'space',
  route: number,
  id: string,
) {
  const identity = { route, id };
  return accessCheck(
    dependencies.access,
    ANONYMOUS,
    kind === 'realm' ? 'realm:read' : 'space:read',
    {
      ...identity,
      eligibility: kind === 'realm' ? realmReadEligibility(identity) : spaceReadEligibility(identity),
    },
    { pool: dependencies.pool, deadline },
  );
}

/** The address anchor is always released before the final home read. A non-null
 * head address without its exact active claim is stale/incomplete, never fallback.
 */
async function activeAddress(
  dependencies: CommunitySitemapDependencies,
  deadline: number,
  spaceId: string,
  address: string,
): Promise<boolean> {
  return withConnection(dependencies.pool, async (client) => {
    const claim = await readSpaceAddress(deadlineClient(client, deadline), address);
    return claim?.spaceId === spaceId;
  });
}

function candidatePosition(candidate: Candidate): Position {
  return { route: candidate.route, id: candidate.id };
}

type RealmSource = Awaited<ReturnType<typeof readRealmHead.run>>;
type SpaceSource = Awaited<ReturnType<typeof readSpace.run>>;

// Authorization is independently rechecked, but the final source read must also
// reject a remove/restore cycle committed after that check. Heads alone survive it.
function sameRealmSource(current: RealmSource, initial: NonNullable<RealmSource>): current is NonNullable<RealmSource> {
  return (
    current !== null &&
    current.head_revision_id === initial.head_revision_id &&
    current.realm_version === initial.realm_version &&
    current.space_id === initial.space_id &&
    current.space_head_revision_id === initial.space_head_revision_id &&
    current.space_version === initial.space_version &&
    current.address === initial.address
  );
}

function sameSpaceSource(current: SpaceSource, initial: NonNullable<SpaceSource>): current is NonNullable<SpaceSource> {
  return (
    current !== null &&
    current.head_revision_id === initial.head_revision_id &&
    current.space_version === initial.space_version &&
    current.address === initial.address
  );
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
  at: string,
): Promise<SitemapRealmItem | null> {
  const params = { ...candidate, at };
  const initial = await withConnection(dependencies.pool, (client) =>
    readRealmHead.run(deadlineClient(client, deadline), params),
  );
  if (!initial) return null;
  const realmCheck = await anonymousCheck(dependencies, deadline, 'realm', candidate.route, candidate.id);
  const spaceCheck = await anonymousCheck(dependencies, deadline, 'space', candidate.route, initial.space_id);
  const admitted = await withConnection(dependencies.pool, async (client) => {
    const home = deadlineClient(client, deadline);
    return (await realmCheck(home)) && (await spaceCheck(home));
  });
  if (!admitted) return null;
  if (initial.address !== null && !(await activeAddress(dependencies, deadline, initial.space_id, initial.address)))
    return null;

  return withConnection(dependencies.pool, async (client) => {
    const home = deadlineClient(client, deadline);
    if (!(await realmCheck(home)) || !(await spaceCheck(home))) return null;
    const board = await newestRealmBoard.run(home, candidate);
    const current = await readRealmHead.run(home, params);
    if (
      !sameRealmSource(current, initial) ||
      current.revision_created_at === null ||
      current.space_revision_created_at === null
    )
      return null;
    return {
      id: candidate.id,
      canonicalDestination:
        current.address === null
          ? { kind: 'realm', realmId: candidate.id }
          : { kind: 'space', spaceId: current.space_id, address: current.address },
      lastModified: latestTimestamp(
        sitemapTimestamp(current.revision_created_at),
        sitemapTimestamp(current.space_revision_created_at),
        board?.created_at ?? null,
      ),
    };
  });
}

async function listedSpace(
  dependencies: CommunitySitemapDependencies,
  deadline: number,
  candidate: Candidate,
  at: string,
): Promise<SitemapSpaceItem | null> {
  const check = await anonymousCheck(dependencies, deadline, 'space', candidate.route, candidate.id);
  const params = { ...candidate, at };
  const initial = await withConnection(dependencies.pool, async (client) => {
    const home = deadlineClient(client, deadline);
    if (!(await check(home))) return null;
    return readSpace.run(home, params);
  });
  if (!initial || initial.address === null || initial.revision_created_at === null) return null;
  if (!(await activeAddress(dependencies, deadline, candidate.id, initial.address))) return null;
  return withConnection(dependencies.pool, async (client) => {
    const home = deadlineClient(client, deadline);
    if (!(await check(home))) return null;
    const head = await readSpace.run(home, params);
    if (!sameSpaceSource(head, initial) || head.address === null || head.revision_created_at === null) return null;
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
        ? await listedRealm(dependencies, deadline, candidate, at)
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

/** Independently anonymous-readable addressed Spaces with an empty native Realm slot. */
export function listSitemapSpaces(
  dependencies: CommunitySitemapDependencies,
  deadline: number,
  input: CommunitySitemapInput = {},
): Promise<CommunitySitemapPage<SitemapSpaceItem>> {
  return list<SitemapSpaceItem>(dependencies, deadline, 'spaces', input);
}

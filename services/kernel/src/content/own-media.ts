import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { ProblemError } from '../http/problem.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withConnection, discardConnection } from '../database/pool.ts';
import { mintReadTime, noEffect, runCommand } from '../command/command.ts';
import {
  prepareReadDecisions,
  type Access,
  type AccountActor,
  type Actor,
  type AccessClient,
  type ReadDecisions,
} from '../request/access.ts';
import { readRealm } from '../community/realm.ts';
import { authorizedRealmMedia, realmMediaVariants } from './realm-media-read.ts';
import type { OwnMediaInventoryPage } from './schemas.ts';
import insertLocator from './own-media-locator.sql';
import page from './own-media-page.sql';
import objects from './own-media-objects.sql';
import { lockErasureFence } from './erasure-fence.ts';

export const OWN_MEDIA_PAGE_SIZE = 20;
const firstMediaId = '00000000-0000-0000-0000-000000000000';
const cursorFilter = 'all-media-v1';
const mediaActions = ['media:read_reservation', 'media:read', 'media:erase', 'thread:read', 'post:read'] as const;

type Cursor = Readonly<{
  version: 1;
  accountId: string;
  authnEpoch: number;
  clientId: string;
  requestedBy: string | null;
  filter: typeof cursorFilter;
  order: 'media-id-ascending';
  after: string;
}>;

type MediaRow = Readonly<{
  id: string;
  context_id: string;
  purpose: 'post-image' | 'avatar' | 'realm-icon' | 'realm-banner' | 'cover';
  state: 'reserved' | 'uploaded' | 'available' | 'rejected';
  media_type: string | null;
  byte_count: string | number | null;
  actual_byte_count: string | number | null;
  created_at: string;
  claimed_at: string | null;
  erased: boolean;
  collection_pending: boolean;
  taken_down: boolean;
  claimed_realm_id: string | null;
  container_kind: 'thread' | 'post' | 'realm' | 'account' | null;
  container_visibility: string | null;
  container_availability: string | null;
  thread_id: string | null;
  variants_json: string;
}>;

type OwnMediaEntry = OwnMediaInventoryPage['entries'][number];
type ReadAction = NonNullable<OwnMediaEntry['actions']['read']>;

type Candidate = Readonly<{
  row: MediaRow;
  container: { id: string; kind: 'thread' | 'post' | 'realm' | 'account' } | null;
  actions: OwnMediaEntry['actions'];
}>;

type OwnMediaDependencies = Readonly<{ pool: Pool; access: Access; routeKey: Uint8Array }>;
type ReadHome = Readonly<{ partition: number; ids: readonly string[] }>;
type DecisionSet = Readonly<Record<string, { allowed: boolean; explicit: boolean }>>;
const noDecisions: DecisionSet = {};

function accountRoute(actor: AccountActor): number {
  const route = routeOf(actor.accountId);
  if (route === null) throw new ProblemError('not_found');
  return route;
}

function cursorFor(actor: AccountActor, after: string): Cursor {
  return {
    version: 1,
    accountId: actor.accountId,
    authnEpoch: actor.authnEpoch,
    clientId: actor.clientId,
    requestedBy: actor.requestedBy,
    filter: cursorFilter,
    order: 'media-id-ascending',
    after,
  };
}

function encodeCursor(actor: AccountActor, after: string, key: Uint8Array): string {
  const payload = Buffer.from(JSON.stringify(cursorFor(actor, after))).toString('base64url');
  const signature = createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function validCursor(value: unknown): value is Cursor {
  if (typeof value !== 'object' || value === null) return false;
  const cursor = value as Record<string, unknown>;
  return (
    cursor.version === 1 &&
    typeof cursor.accountId === 'string' &&
    Number.isSafeInteger(cursor.authnEpoch) &&
    typeof cursor.clientId === 'string' &&
    (cursor.requestedBy === null || typeof cursor.requestedBy === 'string') &&
    cursor.filter === cursorFilter &&
    cursor.order === 'media-id-ascending' &&
    typeof cursor.after === 'string' &&
    routeOf(cursor.after) !== null
  );
}

function decodeCursor(value: string | undefined, actor: AccountActor, key: Uint8Array): string {
  if (value === undefined) return firstMediaId;
  if (value.length > 2048) throw new ProblemError('invalid_request');
  const separator = value.indexOf('.');
  if (separator < 1 || separator !== value.lastIndexOf('.')) throw new ProblemError('invalid_request');
  const payload = value.slice(0, separator);
  const supplied = Buffer.from(value.slice(separator + 1), 'base64url');
  const expected = createHmac('sha256', key).update(payload).digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    throw new ProblemError('invalid_request');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new ProblemError('invalid_request');
  }
  if (!validCursor(parsed)) throw new ProblemError('invalid_request');
  if (
    parsed.accountId !== actor.accountId ||
    parsed.authnEpoch !== actor.authnEpoch ||
    parsed.clientId !== actor.clientId ||
    parsed.requestedBy !== actor.requestedBy
  )
    throw new ProblemError('not_found');
  return parsed.after;
}

async function readLocatorPage(
  pool: Pool,
  homeRoute: number,
  actor: AccountActor,
  after: string,
  deadline: number,
): Promise<readonly string[]> {
  return within(deadline, () =>
    withConnection(pool, async (client) => {
      const bounded = deadlineClient(client, deadline);
      try {
        await bounded.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const home = await readPartition(bounded, partitionOf(homeRoute));
        if (!home || home.writeState === 'moved') throw new ProblemError('partition_unavailable');
        const rows = await page.run(bounded, {
          route: homeRoute,
          account_id: actor.accountId,
          after,
          limit: OWN_MEDIA_PAGE_SIZE,
        });
        await bounded.query('COMMIT');
        return rows.map(({ id }) => id);
      } catch (error) {
        try {
          await bounded.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(client, rollbackError as Error);
        }
        throw error;
      }
    }),
  );
}

function homesFor(ids: readonly string[]): readonly ReadHome[] {
  const grouped = new Map<number, string[]>();
  for (const id of ids) {
    const route = routeOf(id);
    if (route === null) throw new ProblemError('dependency_unavailable');
    const partition = partitionOf(route);
    const list = grouped.get(partition) ?? [];
    list.push(id);
    grouped.set(partition, list);
  }
  return [...grouped]
    .sort(([left], [right]) => left - right)
    .map(([partition, homeIds]) => ({ partition, ids: homeIds }));
}

function decisionsFor(
  decisions: ReadDecisions,
  client: AccessClient,
  action: string,
  resourceType: string,
  ids: readonly string[],
  time: Awaited<ReturnType<typeof mintReadTime>>,
): Promise<DecisionSet> {
  return decisions.decide(client, { action, resourceType, ids }, time);
}

function byteCount(value: string | number | null): number | null {
  if (value === null) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

function timestamp(value: string | null): string | null {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function variantKeys(row: MediaRow): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.variants_json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || parsed.length > 12) return [];
  const allowedWidth = (width: number) => width < 320 || [320, 640, 960, 1280, 1920, 2560].includes(width);
  const keys: string[] = [];
  for (const variant of parsed) {
    if (
      !variant ||
      typeof variant !== 'object' ||
      ((variant as { format?: unknown }).format !== 'avif' && (variant as { format?: unknown }).format !== 'webp')
    )
      return [];
    const value = variant as {
      format: 'avif' | 'webp';
      width: unknown;
      height: unknown;
      mediaType: unknown;
      byteCount: unknown;
    };
    if (
      !Number.isSafeInteger(value.width) ||
      Number(value.width) < 1 ||
      !allowedWidth(Number(value.width)) ||
      !Number.isSafeInteger(value.height) ||
      Number(value.height) < 1 ||
      value.mediaType !== `image/${value.format}` ||
      !Number.isSafeInteger(value.byteCount) ||
      Number(value.byteCount) < 1
    )
      return [];
    keys.push(`${value.format}-${value.width}`);
  }
  return keys;
}

function currentState(row: MediaRow): 'reserved' | 'uploaded' | 'available' | 'rejected' | 'erased' {
  return row.erased ? 'erased' : row.state;
}

function baseCandidate(
  row: MediaRow,
  actor: AccountActor,
  authorized: {
    read: boolean;
    remove: boolean;
    containerRead: boolean;
  },
): Candidate {
  const state = currentState(row);
  const live = state !== 'erased' && !row.collection_pending && !row.taken_down;
  const isAvailable = state === 'available' && live;
  const containerAvailable =
    row.container_visibility !== 'taken_down' && row.container_availability === 'available' && authorized.containerRead;
  const container =
    row.container_kind === 'thread' || row.container_kind === 'post'
      ? containerAvailable
        ? { id: row.context_id, kind: row.container_kind }
        : null
      : row.container_kind === 'account' && row.context_id === actor.accountId
        ? { id: row.context_id, kind: 'account' as const }
        : null;
  const variants = variantKeys(row);
  const readableVariants = row.purpose === 'post-image' && row.claimed_at === null ? [] : variants;
  const readable =
    isAvailable &&
    authorized.read &&
    ((row.purpose === 'post-image' && containerAvailable) ||
      (row.purpose === 'avatar' && row.context_id === actor.accountId && readableVariants.length > 0));
  const read: ReadAction | null = readable
    ? {
        operationId: 'media.authorize_download',
        variants: [...(row.purpose === 'post-image' ? ['original'] : []), ...readableVariants],
        recheckAtUse: true,
      }
    : null;
  const canResume = row.purpose === 'post-image' && live && (state === 'reserved' || state === 'uploaded');
  return {
    row,
    container,
    actions: {
      read,
      remove:
        authorized.remove && state !== 'erased' && !row.collection_pending ? { operationId: 'media.erase' } : null,
      resume: canResume
        ? {
            operationId: 'media.read_reservation',
            mode: state === 'reserved' ? 'same-reservation' : 'processing',
            requiresOriginalFile: true,
          }
        : null,
      retry:
        row.purpose === 'post-image' && state === 'rejected'
          ? { operationId: 'media.create', guidance: 'choose-new-file' }
          : null,
    },
  };
}

async function readObjectHome(
  pool: Pool,
  actor: AccountActor,
  home: ReadHome,
  decisions: ReadDecisions,
  deadline: number,
): Promise<readonly Candidate[]> {
  const routes = home.ids.map((id) => routeOf(id)!);
  return within(deadline, () =>
    withConnection(pool, async (client) => {
      const bounded = deadlineClient(client, deadline);
      try {
        await bounded.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const partition = await readPartition(bounded, home.partition);
        if (!partition || partition.writeState === 'moved') throw new ProblemError('partition_unavailable');
        const rows = (await objects.run(bounded, {
          routes,
          ids: [...home.ids],
          uploader_id: actor.accountId,
        })) as readonly MediaRow[];
        if (rows.length === 0) {
          await bounded.query('COMMIT');
          return [];
        }
        const time = await mintReadTime(bounded);
        const ids = rows.map(({ id }) => id);
        const [reservation, read, remove] = await Promise.all([
          decisionsFor(decisions, bounded, 'media:read_reservation', 'content.media', ids, time),
          decisionsFor(decisions, bounded, 'media:read', 'content.media', ids, time),
          decisionsFor(decisions, bounded, 'media:erase', 'content.media', ids, time),
        ]);
        const threadIds = rows.map(({ thread_id }) => thread_id).filter((id): id is string => id !== null);
        const postIds = rows.filter((row) => row.container_kind === 'post').map(({ context_id }) => context_id);
        const [threads, posts] = await Promise.all([
          threadIds.length
            ? decisionsFor(decisions, bounded, 'thread:read', 'content.thread', [...new Set(threadIds)], time)
            : Promise.resolve(noDecisions),
          postIds.length
            ? decisionsFor(decisions, bounded, 'post:read', 'content.post', [...new Set(postIds)], time)
            : Promise.resolve(noDecisions),
        ]);
        const candidates = rows.flatMap((row) => {
          if (!reservation[row.id]?.allowed) return [];
          const containerRead =
            row.container_kind === 'thread'
              ? Boolean(threads[row.thread_id ?? '']?.allowed)
              : row.container_kind === 'post'
                ? Boolean(posts[row.context_id]?.allowed && threads[row.thread_id ?? '']?.allowed)
                : false;
          return [
            baseCandidate(row, actor, {
              read: Boolean(read[row.id]?.allowed),
              remove: Boolean(remove[row.id]?.allowed),
              containerRead,
            }),
          ];
        });
        await bounded.query('COMMIT');
        return candidates;
      } catch (error) {
        try {
          await bounded.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(client, rollbackError as Error);
        }
        throw error;
      }
    }),
  );
}

async function currentRealmActions(
  deps: OwnMediaDependencies,
  actor: AccountActor,
  candidates: readonly Candidate[],
  deadline: number,
): Promise<readonly Candidate[]> {
  const realmGroups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    if (candidate.row.container_kind !== 'realm') continue;
    const group = realmGroups.get(candidate.row.context_id) ?? [];
    group.push(candidate);
    realmGroups.set(candidate.row.context_id, group);
  }
  if (!realmGroups.size) return candidates;
  const context = { actor, deadline };
  const updates = new Map<string, Candidate>();
  for (const [realmId, group] of realmGroups) {
    const realmRoute = routeOf(realmId);
    let realmVisible = false;
    if (realmRoute !== null) {
      try {
        realmVisible = (await readRealm({ pool: deps.pool, access: deps.access }, actor, realmId, context)) !== null;
      } catch (error) {
        if (!(error instanceof GrantDeniedError) && !(error instanceof ProblemError && error.code === 'not_found'))
          throw error;
      }
    }
    const visibleRows = group.filter(
      (candidate) =>
        realmVisible &&
        currentState(candidate.row) === 'available' &&
        candidate.row.claimed_realm_id === realmId &&
        !candidate.row.collection_pending &&
        !candidate.row.erased &&
        !candidate.row.taken_down,
    );
    const downloadable = new Map<string, string[]>();
    for (let offset = 0; offset < visibleRows.length; offset += 2) {
      const batch = visibleRows.slice(offset, offset + 2);
      const permitted = await authorizedRealmMedia(
        { pool: deps.pool, access: deps.access },
        realmId,
        batch.map(({ row }) => row.id),
        context,
      );
      for (const [id, media] of permitted) {
        const variants = realmMediaVariants(media).map(({ format, width }) => `${format}-${width}`);
        if (variants.length) downloadable.set(id, variants);
      }
    }
    for (const candidate of group) {
      const variants = downloadable.get(candidate.row.id);
      updates.set(candidate.row.id, {
        ...candidate,
        container: realmVisible ? { id: realmId, kind: 'realm' } : null,
        actions: {
          ...candidate.actions,
          read: variants ? { operationId: 'media.authorize_download', variants, recheckAtUse: true } : null,
        },
      });
    }
  }
  return candidates.map((candidate) => updates.get(candidate.row.id) ?? candidate);
}

function entry(candidate: Candidate): OwnMediaInventoryPage['entries'][number] {
  const row = candidate.row;
  const createdAt = timestamp(row.created_at);
  if (createdAt === null) throw new ProblemError('dependency_unavailable');
  return {
    id: row.id,
    purpose: row.purpose,
    state: currentState(row),
    declaredMediaType: row.media_type,
    actualMediaType: null,
    declaredByteCount: byteCount(row.byte_count),
    actualByteCount: byteCount(row.actual_byte_count),
    createdAt,
    claimedAt: timestamp(row.claimed_at),
    collectionPending: row.collection_pending,
    takenDown: row.taken_down || row.container_visibility === 'taken_down',
    container: candidate.container,
    actions: candidate.actions,
  };
}

/** Add a committed browser reservation to the existing account-home erasure locator.
 * The registered reserved-event projection repeats this upsert as its durable repair path. */
export async function recordOwnMediaReservation(pool: Pool, actor: AccountActor, mediaId: string): Promise<void> {
  const mediaRoute = routeOf(mediaId);
  const homeRoute = accountRoute(actor);
  if (mediaRoute === null) throw new ProblemError('not_found');
  await runCommand(pool, { partition: partitionOf(homeRoute) }, async (tx) => {
    if (await lockErasureFence(tx, actor.accountId)) return noEffect(null);
    await insertLocator.run(tx, { route: homeRoute, account_id: actor.accountId, id: mediaId });
    return noEffect(null);
  });
}

/** Read a raw keyset page from the actor home, then batch current state and authority
 * in each selected media home. A failed home fails the whole page so its cursor
 * remains at the same frontier; invisible or collected locators are sparse rows. */
export async function readOwnMediaInventory(
  deps: OwnMediaDependencies,
  actor: Actor,
  input: Readonly<{ cursor?: string }>,
  deadline: number,
): Promise<OwnMediaInventoryPage> {
  if (actor.kind !== 'account') throw new ProblemError('not_found');
  const after = decodeCursor(input.cursor, actor, deps.routeKey);
  const locatorRoute = accountRoute(actor);
  const rawIds = await readLocatorPage(deps.pool, locatorRoute, actor, after, deadline);
  if (rawIds.length === 0) return { availability: 'available', entries: [], nextCursor: null };
  const homes = homesFor(rawIds);
  const decisions = await prepareReadDecisions(deps.access, {
    actor,
    actions: new Set(mediaActions),
    context: { pool: deps.pool, deadline },
  });
  const candidates = (
    await Promise.all(homes.map((home) => readObjectHome(deps.pool, actor, home, decisions, deadline)))
  )
    .flat()
    .sort((left, right) => left.row.id.localeCompare(right.row.id));
  const current = await currentRealmActions(deps, actor, candidates, deadline);
  const nextCursor = rawIds.length === OWN_MEDIA_PAGE_SIZE ? encodeCursor(actor, rawIds.at(-1)!, deps.routeKey) : null;
  return {
    availability: 'available',
    entries: current.map(entry),
    nextCursor,
  };
}

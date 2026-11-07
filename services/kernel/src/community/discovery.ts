import { exactRealmPresentationImage, readRealmPresentationImages } from './domain-ports.ts';
import type { RealmPresentationImage } from '../content/realm-media.ts';
import { ProblemError } from '../http/problem-error.ts';
import { routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';

export const DISCOVERY_DEFINITION_VERSION = 1;
export const DISCOVERY_CANDIDATE_CAP = 20;
const DAY_MS = 86_400_000;

export type DiscoverySort = 'popular' | 'trending';
export type DiscoveryQuery = { sort: DiscoverySort; limit?: number; cursor?: string };
export type DiscoveryRealm = {
  realmId: string;
  spaceId: string;
  name: string;
  description: string;
  avatar: RealmPresentationImage | null;
};
export type DiscoveryPage = { realms: DiscoveryRealm[]; next: string | null };

/** Half-open day interval: today's activity never enters a completed-day rank. */
export function discoveryWindow(sort: DiscoverySort, at: Date): { from: string; cutoff: string } {
  if (sort !== 'popular' && sort !== 'trending') throw new ProblemError('invalid_request');
  const instant = at.getTime();
  if (!Number.isFinite(instant)) throw new TypeError('Discovery requires valid authoritative time');
  const cutoff = Math.floor(instant / DAY_MS) * DAY_MS;
  return {
    from: new Date(cutoff - (sort === 'popular' ? 30 : 1) * DAY_MS).toISOString().slice(0, 10),
    cutoff: new Date(cutoff).toISOString().slice(0, 10),
  };
}

/** The normalized API limit remains in the cursor binding even when the candidate cap is lower. */
export function discoveryLimit(limit: number = 20): { limit: number; candidates: number } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ProblemError('invalid_request');
  return { limit, candidates: Math.min(limit, DISCOVERY_CANDIDATE_CAP) };
}

export { discoveryDescription } from './contract/index.ts';

/** Internal rank position only. A position conveys no source or visibility authority. */
export type DiscoveryPosition = { count: string; realmId: string };
export type DiscoveryCursorContext = {
  sort: DiscoverySort;
  limit?: number;
  cutoff: string;
  partitionEpoch: number;
  publicationEpoch: string;
};

function binding(context: DiscoveryCursorContext): CursorBinding {
  if (context.sort !== 'popular' && context.sort !== 'trending') throw new ProblemError('invalid_request');
  return {
    operation: 'community.realms.discovery',
    parameters: {
      sort: context.sort,
      limit: discoveryLimit(context.limit).limit,
      definition: DISCOVERY_DEFINITION_VERSION,
    },
  };
}

function validPosition(position: DiscoveryPosition): boolean {
  // PostgreSQL count is bigint. Preserve its decimal representation without rounding through Number.
  return (
    /^(?:[1-9][0-9]{0,18})$/.test(position.count) &&
    BigInt(position.count) <= 9_223_372_036_854_775_807n &&
    routeOf(position.realmId) !== null
  );
}

function assertContext(context: DiscoveryCursorContext): void {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(context.cutoff) ||
    !Number.isFinite(Date.parse(`${context.cutoff}T00:00:00.000Z`)) ||
    new Date(`${context.cutoff}T00:00:00.000Z`).toISOString().slice(0, 10) !== context.cutoff ||
    !Number.isSafeInteger(context.partitionEpoch) ||
    context.partitionEpoch < 1 ||
    typeof context.publicationEpoch !== 'string' ||
    context.publicationEpoch.length < 1 ||
    context.publicationEpoch.length > 256
  ) {
    throw new TypeError('Discovery requires current partition and publication epochs and cutoff');
  }
}

/** Encode the last examined candidate, including when every examined candidate was suppressed. */
export function encodeDiscoveryCursor(
  tokens: KeyRing,
  context: DiscoveryCursorContext,
  position: DiscoveryPosition,
  now: number,
): string {
  assertContext(context);
  if (!validPosition(position)) throw new TypeError('Invalid discovery rank position');
  return encodeCursor(
    tokens,
    binding(context),
    {
      epoch: context.partitionEpoch,
      after: [context.cutoff, context.publicationEpoch, position.count, position.realmId],
    },
    now,
  );
}

export function decodeDiscoveryCursor(
  tokens: KeyRing,
  context: DiscoveryCursorContext,
  token: string,
  now: number,
): DiscoveryPosition {
  assertContext(context);
  const decoded = decodeCursor(tokens, binding(context), token, now);
  if (!decoded.ok || decoded.after.length !== 4) throw new ProblemError('invalid_cursor');
  const [cutoff, publicationEpoch, count, realmId] = decoded.after;
  if (
    typeof cutoff !== 'string' ||
    typeof publicationEpoch !== 'string' ||
    typeof count !== 'string' ||
    typeof realmId !== 'string' ||
    !validPosition({ count, realmId })
  ) {
    throw new ProblemError('invalid_cursor');
  }
  if (
    decoded.epoch !== context.partitionEpoch ||
    cutoff !== context.cutoff ||
    publicationEpoch !== context.publicationEpoch
  )
    throw new ProblemError('stale_cursor');
  return { count, realmId };
}

import type { Pool } from 'pg';
import type { Access } from '../request/access.ts';
import { AccessUnavailableError } from '../access/unavailable.ts';
import { DISCOVERY_PARTITION, discoverySnapshot, stateColumns } from './discovery-projection-store.ts';
import {
  currentDiscoveryCandidates,
  prepareDiscoveryAccess,
  readDiscoveryCards,
  type DiscoveryCandidate,
} from './discovery-projection-read.ts';

export type DiscoveryDependencies = {
  pool: Pool;
  access: Access;
  tokens: KeyRing;
  clock: () => Date;
  /** Real wall time for the snapshot and cursor budgets, supplied by composition. */
  deadlineNow: () => number;
};

/** Public pages examine one rank range of at most twenty keys, including suppressed keys. */
export async function listRealmDiscovery(
  deps: DiscoveryDependencies,
  deadline: number,
  input: DiscoveryQuery,
): Promise<DiscoveryPage> {
  const at = deps.clock();
  const cutoff = discoveryWindow(input.sort, at).cutoff;
  const limit = discoveryLimit(input.limit);
  const page = await discoverySnapshot(
    deps.pool,
    DISCOVERY_PARTITION,
    { deadline, now: deps.deadlineNow },
    async (client, epoch) => {
      const anchor = (
        await client.query<{ publication_epoch: string }>(
          'SELECT publication_epoch::text FROM community.discovery_anchor WHERE route=0',
        )
      ).rows[0];
      if (!anchor) throw new AccessUnavailableError('overloaded');
      const context: DiscoveryCursorContext = {
        sort: input.sort,
        limit: limit.limit,
        cutoff,
        partitionEpoch: epoch,
        publicationEpoch: anchor.publication_epoch,
      };
      const after =
        input.cursor === undefined ? null : decodeDiscoveryCursor(deps.tokens, context, input.cursor, at.getTime());
      const column = input.sort === 'popular' ? 'popular' : 'trending';
      const rows = (
        await client.query<DiscoveryCandidate>(
          `SELECT ${stateColumns},${column}::text AS count
      FROM community.discovery_realm WHERE route=0 AND ${column}>0
      ${after ? `AND (-${column},realm_id)>($1::bigint,$2::uuid)` : ''}
      ORDER BY (-${column}),realm_id LIMIT $${after ? 3 : 1}`,
          after ? [(-BigInt(after.count)).toString(), after.realmId, limit.candidates] : [limit.candidates],
        )
      ).rows;
      return { rows, context };
    },
  );
  let cards = new Map<string, DiscoveryRealm>();
  if (page.rows.length) {
    const decisions = await prepareDiscoveryAccess(deps.pool, deps.access, deadline);
    const first = await readDiscoveryCards(deps.pool, decisions, page.rows, cutoff, at.toISOString(), {
      deadline,
      now: deps.deadlineNow,
    });
    const avatars = new Map<string, RealmPresentationImage>();
    // All owner snapshots are released. Only selected avatars of the examined,
    // anonymously readable candidates reach the native media authority.
    for (const [realmId, card] of first) {
      if (card.avatarMediaId === null) continue;
      const { avatar } = await readRealmPresentationImages(
        { pool: deps.pool, access: deps.access, clock: deps.clock },
        { realmId, avatarMediaId: card.avatarMediaId, bannerMediaId: null },
        { actor: { kind: 'anonymous' }, deadline },
      );
      if (avatar.state !== 'available') continue;
      const image = exactRealmPresentationImage(avatar.value);
      if (image && image.id === card.avatarMediaId && image.containerId === realmId) avatars.set(realmId, image);
    }
    const current = await currentDiscoveryCandidates(
      deps.pool,
      page.rows.filter((row) => first.has(row.realm_id)),
      { deadline, now: deps.deadlineNow },
    );
    const final = await readDiscoveryCards(deps.pool, decisions, current, cutoff, deps.clock().toISOString(), {
      deadline,
      now: deps.deadlineNow,
    });
    for (const [realmId, card] of final) {
      if (first.get(realmId)?.binding !== card.binding) continue;
      cards.set(realmId, { ...card.value, avatar: avatars.get(realmId) ?? null });
    }
    await discoverySnapshot(
      deps.pool,
      DISCOVERY_PARTITION,
      { deadline, now: deps.deadlineNow },
      async (client, epoch) => {
        const anchor = (
          await client.query<{ publication_epoch: string }>(
            'SELECT publication_epoch::text FROM community.discovery_anchor WHERE route=0',
          )
        ).rows[0];
        if (!anchor) throw new AccessUnavailableError('overloaded');
        if (
          epoch !== page.context.partitionEpoch ||
          anchor.publication_epoch !== page.context.publicationEpoch ||
          discoveryWindow(input.sort, deps.clock()).cutoff !== cutoff
        )
          throw new ProblemError('stale_cursor');
      },
    );
  }
  const last = page.rows.at(-1);
  return {
    realms: page.rows.flatMap((row) => {
      const card = cards.get(row.realm_id);
      return card ? [card] : [];
    }),
    next:
      page.rows.length === limit.candidates && last
        ? encodeDiscoveryCursor(deps.tokens, page.context, { count: last.count, realmId: last.realm_id }, at.getTime())
        : null,
  };
}

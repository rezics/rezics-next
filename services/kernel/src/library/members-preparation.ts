import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { releaseDigest, type Release } from '@rezics/definitions';
import { admitFilter, parseFilter, type FilterDocument, type FilterRelease } from '@rezics/filter';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { systemClock } from '../clock.ts';
import { currentOperationalResources, hasLiveOperationalTransaction } from '../command/operational.ts';
import {
  authoritativeTimeValue,
  commandTime,
  DEFAULT_REQUEST_DEADLINE_MS,
  principalCommandIdentity,
} from '../command/command.ts';
import { enqueueIntent, runOperationalTransaction, type OperationalTransaction } from '../command/operational.ts';
import { deadlineFor } from '../request/deadline.ts';
import { accessCommandAuthorization, type Access, type Actor } from '../request/access.ts';
import { ProblemError } from '../http/problem.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { readRelease } from '../semantic/definitions.ts';
import type { WorkClient } from '../work/client.ts';
import type { NativeSourceIdentity } from './native-source-custody.ts';
import type { CollectionSourceObservation } from './collection-source.ts';

const LIVE_LIMIT = 32;
const IDLE_MS = 24 * 60 * 60 * 1000;
const MAX_DEFINITIONS = 16;
const BASIS_VERSION = 1;

/** Internal admitted meaning, never an HTTP DTO or an execution/disclosure certificate. */
export type PreparationDefinition = Readonly<{
  filter: FilterDocument;
  sort: 'id' | 'ordinal';
  release: Readonly<{ digest: string; value: FilterRelease }>;
}>;
export type PreparationLocator = Readonly<{
  route: number;
  ownerAccountId: string;
  collectionId: string;
  episodeId: string;
}>;
/** Exact retained native episode inputs. Data only; never admission or disclosure authority. */
export type MembersPreparationWorkDefinition = Readonly<{
  definition: PreparationDefinition;
  sourceIdentity: NativeSourceIdentity;
  observation: CollectionSourceObservation;
}>;
export type PreparationIntent = Readonly<{
  queue: 'workflows';
  workflowName: 'library.membersPreparation';
  workflowId: string;
  input: Readonly<{
    accounts: readonly [string];
    route: number;
    episodes: readonly Readonly<{ collectionId: string; episodeId: string }>[];
    cleanup: readonly Readonly<{ collectionId: string; episodeId: string }>[];
  }>;
}>;
export type PreparingEpisode = Readonly<{
  state: 'preparing';
  locator: PreparationLocator;
  workflowId: string;
}>;
export interface MembersPreparation {
  /** One Collection's distinct definitions, bounded by the common-page read authority. */
  reserve(
    actor: Actor,
    collectionId: string,
    definitions: readonly PreparationDefinition[],
    options?: { deadline?: number },
  ): Promise<Readonly<{ episodes: readonly PreparingEpisode[]; intent: PreparationIntent | null }>>;
  /** Only the admitted reader calls this after an actual read; duplicate preparation does not touch LRU. */
  touch(actor: Actor, locator: PreparationLocator, options?: { deadline?: number }): Promise<boolean>;
  /** Called inside the registered step's fenced operational transaction; locks survive to its commit. */
  admitStep(tx: OperationalTransaction, locator: PreparationLocator): Promise<boolean>;
  /** Read-only on the SAME live admitted Core client; null for an obsolete or unbound episode. */
  readWorkDefinition(
    tx: OperationalTransaction,
    locator: PreparationLocator,
  ): Promise<MembersPreparationWorkDefinition | null>;
}

type Basis = Readonly<{
  basis: string;
  digest: Buffer;
  filter: FilterDocument;
  sort: PreparationDefinition['sort'];
  releaseDigest: string;
  release: FilterRelease;
}>;
type Header = {
  route: number;
  owner_account_id: string;
  collection_id: string;
  episode_id: string;
  canonical_basis: string;
  basis_digest: Buffer;
  state: 'live' | 'retired';
  last_read_at: Date | string;
  workflow_id: string;
  reserved_incarnation: string;
  reserved_generation: string;
};
type Retired = Readonly<{ collectionId: string; episodeId: string }>;

function unsupported(): ProblemError {
  return new ProblemError('unsupported_query');
}

function notFound(): ProblemError {
  return new ProblemError('not_found');
}

function prepareBasis(ownerAccountId: string, collectionId: string, input: PreparationDefinition): Basis {
  try {
    if (
      !input ||
      !input.filter ||
      (input.sort !== 'id' && input.sort !== 'ordinal') ||
      !input.release ||
      typeof input.release.digest !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(input.release.digest) ||
      !input.release.value ||
      releaseDigest(input.release.value as Release) !== input.release.digest
    )
      throw unsupported();
    const release = structuredClone(input.release.value) as FilterRelease;
    const filter = admitFilter(parseFilter(input.filter), release, { owner: true });
    const basis = canonicalize([BASIS_VERSION, ownerAccountId, collectionId, filter, input.sort, input.release.digest]);
    if (!basis || Buffer.byteLength(basis) > 196_608) throw unsupported();
    return Object.freeze({
      basis,
      digest: createHash('sha256').update(basis).digest(),
      filter,
      sort: input.sort,
      releaseDigest: input.release.digest,
      release,
    });
  } catch (error) {
    if (error instanceof ProblemError) throw error;
    throw unsupported();
  }
}

function validLocator(locator: PreparationLocator): boolean {
  const route = routeOf(locator.collectionId);
  return (
    route !== null &&
    locator.route === route &&
    routeOf(locator.ownerAccountId) === route &&
    routeOf(locator.episodeId) === route &&
    Number.isInteger(locator.route) &&
    locator.route >= 0 &&
    locator.route <= 65_535
  );
}

function currentCollectionSQL() {
  return `SELECT c.collection_id::text AS collection_id,c.curator_account_id::text AS curator_account_id,
    c.membership_kind,c.builtin_kind,c.revision::text AS revision,c.source_generation::text AS generation,
    c.collection_id::text||':'||extract(epoch FROM c.created_at)::text AS incarnation
    FROM library.collection c
    WHERE c.route=$1 AND c.collection_id=$2 AND c.curator_account_id=$3 AND c.state='active'
      AND c.membership_kind IN ('curated','dynamic') AND c.builtin_kind IS NULL
    FOR SHARE`;
}

async function ensureOwnerControl(tx: OperationalTransaction, route: number, ownerAccountId: string) {
  let row = (
    await tx.query<{ live_count: number }>(
      'SELECT live_count FROM library.members_preparation_owner WHERE route=$1 AND owner_account_id=$2 FOR UPDATE',
      [route, ownerAccountId],
    )
  ).rows[0];
  if (!row) {
    await tx.query(
      'INSERT INTO library.members_preparation_owner(route,owner_account_id,live_count) VALUES($1,$2,0) ON CONFLICT DO NOTHING',
      [route, ownerAccountId],
    );
    row = (
      await tx.query<{ live_count: number }>(
        'SELECT live_count FROM library.members_preparation_owner WHERE route=$1 AND owner_account_id=$2 FOR UPDATE',
        [route, ownerAccountId],
      )
    ).rows[0];
  }
  if (!row || !Number.isSafeInteger(row.live_count) || row.live_count < 0 || row.live_count > LIVE_LIMIT)
    throw new ProblemError('dependency_unavailable');
  return row.live_count;
}

function expired(row: Header, now: string): boolean {
  const readAt = row.last_read_at instanceof Date ? row.last_read_at.getTime() : Date.parse(row.last_read_at);
  const nowAt = Date.parse(now);
  return !Number.isFinite(readAt) || !Number.isFinite(nowAt) || readAt <= nowAt - IDLE_MS;
}

async function retireHeaders(
  tx: OperationalTransaction,
  route: number,
  ownerAccountId: string,
  episodeIds: readonly string[],
): Promise<Retired[]> {
  if (!episodeIds.length) return [];
  const rows = (
    await tx.query<Retired>(
      `UPDATE library.members_preparation SET state='retired'
       WHERE route=$1 AND owner_account_id=$2 AND episode_id=ANY($3::uuid[]) AND state='live'
       RETURNING collection_id::text AS "collectionId",episode_id::text AS "episodeId"`,
      [route, ownerAccountId, [...episodeIds]],
    )
  ).rows;
  return rows;
}

/** Native private episode admission. Work starts only after Core and Access have admitted the current owner. */
export function createMembersPreparation(config: {
  pool: Pool;
  workClient: WorkClient;
  access: Access;
  clock?: KernelClock;
}): MembersPreparation {
  const clock = config.clock ?? systemClock;
  const service: MembersPreparation = {
    async reserve(actor, collectionId, definitions, options = {}) {
      const route = routeOf(collectionId);
      if (
        actor.kind !== 'account' ||
        route === null ||
        routeOf(actor.accountId) !== route ||
        definitions.length > MAX_DEFINITIONS
      )
        throw notFound();
      if (!definitions.length) return { episodes: [], intent: null };

      const identity = principalCommandIdentity(actor);
      if (identity.principal.kind !== 'account' || identity.principal.id !== actor.accountId) throw notFound();
      const byBasis = new Map<string, Basis>();
      const requestOrder: string[] = [];
      for (const input of definitions) {
        const basis = prepareBasis(actor.accountId, collectionId, structuredClone(input));
        const key = basis.digest.toString('hex');
        const previous = byBasis.get(key);
        if (previous && previous.basis !== basis.basis) throw unsupported();
        if (!previous) {
          byBasis.set(key, basis);
          requestOrder.push(key);
        }
      }

      const deadline = options.deadline ?? deadlineFor(DEFAULT_REQUEST_DEADLINE_MS);
      const authorization = await accessCommandAuthorization(
        config.access,
        actor,
        'collection:read',
        { route, id: collectionId },
        { pool: config.pool, deadline },
        notFound,
      );
      return runOperationalTransaction(
        config.pool,
        {
          mode: 'request',
          ...identity,
          partition: partitionOf(route),
          kind: 'library.membersPreparation.reserve',
          accounts: [identity.principal.id],
          workClient: config.workClient,
          authorization,
          deadline,
          clock,
        },
        async (tx) => {
          const nowToken = commandTime(tx);
          if (!nowToken) throw new ProblemError('dependency_unavailable');
          const now = authoritativeTimeValue(nowToken);
          const collection = (
            await tx.query<{
              collection_id: string;
              curator_account_id: string;
              membership_kind: string;
              builtin_kind: string | null;
              generation: string;
              incarnation: string;
            }>(currentCollectionSQL(), [route, collectionId, actor.accountId])
          ).rows[0];
          if (
            !collection ||
            collection.curator_account_id !== actor.accountId ||
            collection.builtin_kind !== null ||
            (collection.membership_kind !== 'curated' && collection.membership_kind !== 'dynamic')
          )
            throw notFound();

          // Confirm the exact immutable release bytes on the owning native client. A digest is only an index.
          const releases = new Map<string, FilterRelease>();
          for (const basis of byBasis.values()) {
            if (releases.has(basis.releaseDigest)) continue;
            const actual = await readRelease(tx, basis.releaseDigest);
            if (!actual || canonicalize(actual) !== canonicalize(basis.release)) throw unsupported();
            releases.set(basis.releaseDigest, basis.release);
          }

          let liveCount = await ensureOwnerControl(tx, route, actor.accountId);
          const digestBytes = requestOrder.map((key) => byBasis.get(key)!.digest);
          const exactBases = requestOrder.map((key) => byBasis.get(key)!.basis);
          const matches = (
            await tx.query<Header & { requested_basis: string }>(
              `SELECT h.route,h.owner_account_id::text,h.collection_id::text,h.episode_id::text,h.canonical_basis,
                h.basis_digest,h.state,h.last_read_at,h.workflow_id,h.reserved_incarnation,h.reserved_generation,
                requested.canonical_basis AS requested_basis
               FROM unnest($3::bytea[],$4::text[]) AS requested(basis_digest,canonical_basis)
               JOIN library.members_preparation h ON h.route=$1 AND h.owner_account_id=$2
                 AND h.basis_digest=requested.basis_digest AND h.state='live'
               FOR UPDATE OF h`,
              [route, actor.accountId, digestBytes, exactBases],
            )
          ).rows;
          const found = new Map<string, Header>();
          for (const row of matches) {
            const basis = byBasis.get(Buffer.from(row.basis_digest).toString('hex'));
            if (!basis) throw unsupported();
            if (row.canonical_basis !== row.requested_basis || row.canonical_basis !== basis.basis) throw unsupported();
            found.set(Buffer.from(row.basis_digest).toString('hex'), row);
          }

          const obsoleteIds = [...found.entries()]
            .filter(
              ([, row]) =>
                expired(row, now) ||
                row.reserved_incarnation !== collection.incarnation ||
                row.reserved_generation !== collection.generation,
            )
            .map(([, row]) => row.episode_id);
          const cleanups: Retired[] = await retireHeaders(tx, route, actor.accountId, obsoleteIds);
          liveCount -= cleanups.length;
          const obsolete = new Set(obsoleteIds);
          for (const [key, row] of found) if (obsolete.has(row.episode_id)) found.delete(key);

          const newKeys = requestOrder.filter((key) => !found.has(key));
          const need = Math.max(0, liveCount + newKeys.length - LIVE_LIMIT);
          if (need) {
            const lru = (
              await tx.query<{ episode_id: string }>(
                `SELECT episode_id::text FROM library.members_preparation
                 WHERE route=$1 AND owner_account_id=$2 AND state='live'
                 ORDER BY last_read_at ASC,episode_id ASC LIMIT $3 FOR UPDATE`,
                [route, actor.accountId, need],
              )
            ).rows;
            if (lru.length !== need) throw new ProblemError('dependency_unavailable');
            cleanups.push(
              ...(await retireHeaders(
                tx,
                route,
                actor.accountId,
                lru.map((row) => row.episode_id),
              )),
            );
            liveCount -= need;
          }

          const ids = new Map<string, string>();
          for (const key of newKeys) ids.set(key, newId(route));
          const workflowId = newKeys.length
            ? `library:members-preparation:${route}:${actor.accountId}:${[...ids.values()].sort()[0]}`
            : null;
          if (newKeys.length && workflowId) {
            const inserted = (
              await tx.query<{ episode_id: string }>(
                `INSERT INTO library.members_preparation
                  (route,owner_account_id,collection_id,episode_id,canonical_basis,basis_digest,state,last_read_at,
                   workflow_id,reserved_incarnation,reserved_generation)
                 SELECT $1,$2,$3,value.episode_id::uuid,value.canonical_basis,value.basis_digest,'live',$6,$7,$4,$5
                 FROM unnest($8::uuid[],$9::text[],$10::bytea[]) AS value(episode_id,canonical_basis,basis_digest)
                 ON CONFLICT DO NOTHING RETURNING episode_id::text`,
                [
                  route,
                  actor.accountId,
                  collectionId,
                  collection.incarnation,
                  collection.generation,
                  now,
                  workflowId,
                  newKeys.map((key) => ids.get(key)),
                  newKeys.map((key) => byBasis.get(key)!.basis),
                  newKeys.map((key) => byBasis.get(key)!.digest),
                ],
              )
            ).rows;
            if (inserted.length !== newKeys.length) throw new ProblemError('dependency_unavailable');
            liveCount += inserted.length;
          }

          if (cleanups.length || newKeys.length) {
            await tx.query(
              'UPDATE library.members_preparation_owner SET live_count=$3 WHERE route=$1 AND owner_account_id=$2',
              [route, actor.accountId, liveCount],
            );
          }

          const episodes = requestOrder.map((key) => {
            const previous = found.get(key);
            return Object.freeze({
              state: 'preparing' as const,
              locator: Object.freeze({
                route,
                ownerAccountId: actor.accountId,
                collectionId,
                episodeId: previous?.episode_id ?? ids.get(key)!,
              }),
              workflowId: previous?.workflow_id ?? workflowId!,
            });
          });
          if (!newKeys.length) return { episodes, intent: null };

          const input: PreparationIntent['input'] = Object.freeze({
            accounts: Object.freeze([actor.accountId]) as readonly [string],
            route,
            episodes: Object.freeze(
              newKeys
                .map((key) => Object.freeze({ collectionId, episodeId: ids.get(key)! }))
                .sort((a, b) => a.collectionId.localeCompare(b.collectionId) || a.episodeId.localeCompare(b.episodeId)),
            ),
            cleanup: Object.freeze(
              [...new Map(cleanups.map((item) => [`${item.collectionId}:${item.episodeId}`, item])).values()]
                .sort((a, b) => a.collectionId.localeCompare(b.collectionId) || a.episodeId.localeCompare(b.episodeId))
                .map((item) => Object.freeze(item)),
            ),
          });
          const intent: PreparationIntent = Object.freeze({
            queue: 'workflows',
            workflowName: 'library.membersPreparation',
            workflowId: workflowId!,
            input,
          });
          await enqueueIntent(tx, intent);
          return { episodes, intent };
        },
      );
    },

    async touch(actor, locator, options = {}) {
      if (actor.kind !== 'account' || !validLocator(locator) || locator.ownerAccountId !== actor.accountId)
        return false;
      const identity = principalCommandIdentity(actor);
      if (identity.principal.kind !== 'account') return false;
      const deadline = options.deadline ?? deadlineFor(DEFAULT_REQUEST_DEADLINE_MS);
      const authorization = await accessCommandAuthorization(
        config.access,
        actor,
        'collection:read',
        { route: locator.route, id: locator.collectionId },
        { pool: config.pool, deadline },
        notFound,
      );
      return runOperationalTransaction(
        config.pool,
        {
          mode: 'request',
          ...identity,
          partition: partitionOf(locator.route),
          kind: 'library.membersPreparation.touch',
          accounts: [actor.accountId],
          workClient: config.workClient,
          authorization,
          deadline,
          clock,
        },
        async (tx) => {
          const nowToken = commandTime(tx);
          if (!nowToken) return false;
          const now = authoritativeTimeValue(nowToken);
          const collection = (
            await tx.query<{ incarnation: string; generation: string }>(currentCollectionSQL(), [
              locator.route,
              locator.collectionId,
              actor.accountId,
            ])
          ).rows[0];
          if (!collection) return false;
          const [owner] = (
            await tx.query(
              'SELECT owner_account_id FROM library.members_preparation_owner WHERE route=$1 AND owner_account_id=$2 FOR UPDATE',
              [locator.route, actor.accountId],
            )
          ).rows;
          if (!owner) return false;
          const [header] = (
            await tx.query<Header>(
              `SELECT route,owner_account_id::text,collection_id::text,episode_id::text,canonical_basis,basis_digest,
                state,last_read_at,workflow_id,reserved_incarnation,reserved_generation
               FROM library.members_preparation WHERE route=$1 AND owner_account_id=$2 AND collection_id=$3
                 AND episode_id=$4 AND state='live' FOR UPDATE`,
              [locator.route, locator.ownerAccountId, locator.collectionId, locator.episodeId],
            )
          ).rows;
          if (
            !header ||
            expired(header, now) ||
            header.reserved_incarnation !== collection.incarnation ||
            header.reserved_generation !== collection.generation
          )
            return false;
          const changed = await tx.query(
            `UPDATE library.members_preparation SET last_read_at=GREATEST(last_read_at,$5::timestamptz)
             WHERE route=$1 AND owner_account_id=$2 AND collection_id=$3 AND episode_id=$4 AND state='live'`,
            [locator.route, locator.ownerAccountId, locator.collectionId, locator.episodeId, now],
          );
          return changed.rowCount === 1;
        },
      );
    },

    async admitStep(tx, locator) {
      if (!validLocator(locator) || !hasLiveOperationalTransaction(tx)) return false;
      let resources;
      try {
        resources = currentOperationalResources(tx);
      } catch {
        return false;
      }
      if (
        resources.pool !== config.pool ||
        resources.workClient !== config.workClient ||
        resources.mode !== 'work-step' ||
        resources.kind !== 'library.membersPreparation.step' ||
        resources.partition !== partitionOf(locator.route) ||
        resources.accounts.length !== 1 ||
        resources.accounts[0] !== locator.ownerAccountId
      )
        return false;
      const nowToken = commandTime(tx);
      if (!nowToken) return false;
      const now = authoritativeTimeValue(nowToken);
      const [owner] = (
        await tx.query(
          'SELECT owner_account_id FROM library.members_preparation_owner WHERE route=$1 AND owner_account_id=$2 FOR SHARE',
          [locator.route, locator.ownerAccountId],
        )
      ).rows;
      if (!owner) return false;
      const collection = (
        await tx.query<{ incarnation: string; generation: string }>(currentCollectionSQL(), [
          locator.route,
          locator.collectionId,
          locator.ownerAccountId,
        ])
      ).rows[0];
      if (!collection) return false;
      const [header] = (
        await tx.query<Header>(
          `SELECT h.route,h.owner_account_id::text,h.collection_id::text,h.episode_id::text,h.canonical_basis,
            h.basis_digest,h.state,h.last_read_at,h.workflow_id,h.reserved_incarnation,h.reserved_generation
           FROM library.members_preparation h
           WHERE h.route=$1 AND h.owner_account_id=$2 AND h.collection_id=$3 AND h.episode_id=$4 AND h.state='live'
             AND h.last_read_at>$5::timestamptz-interval '24 hours'
             AND h.reserved_incarnation=$6 AND h.reserved_generation=$7
           FOR UPDATE OF h`,
          [
            locator.route,
            locator.ownerAccountId,
            locator.collectionId,
            locator.episodeId,
            now,
            collection.incarnation,
            collection.generation,
          ],
        )
      ).rows;
      return !!header;
    },

    async readWorkDefinition(tx, locator) {
      if (!hasLiveOperationalTransaction(tx)) return null;
      const resources = currentOperationalResources(tx);
      if (
        resources.pool !== config.pool ||
        resources.workClient !== config.workClient ||
        resources.mode !== 'work-step'
      )
        return null;
      if ((await service.admitStep(tx, locator)) !== true) return null;
      // Source owns the complete native declaration and physical execution authority. Until its producer is
      // connected here, a retained reservation never becomes a fabricated ready definition.
      throw new ProblemError('dependency_unavailable');
    },
  };
  return service;
}

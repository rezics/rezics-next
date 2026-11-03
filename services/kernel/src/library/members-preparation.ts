import { deadlineClient, within } from '../access/authenticate.ts';
import { withReadTransaction } from '../semantic/read.ts';
import type { IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import { decodeListCursor, encodeListCursor, type ListCursorBinding } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import ownerFence from './owner-filter-native-binding-fence.sql';
import { compileCurrentOwnerFilter } from '../search/current-filter-plan.ts';
import readHeader from './members-preparation-read.sql';
import readResults from './members-preparation-results.sql';
import step from './members-preparation-step.sql';
import nativeSource from './members-preparation-source.sql';
import original from './members-preparation-original.sql';
import completionResult from './members-preparation-completion.sql';
import { admitSavedCollectionMemberQuery, type CollectionMemberAdmission } from './owner-filter.ts';
import {
  bindOwnerFilterRead,
  readOwnerFilterCandidateClosure,
  readOwnerFilterCandidate,
  type OwnerFilterReadBinding,
} from './owner-filter-plan.ts';
import {
  nativeOwnerFilterBinding,
  releaseNativeOwnerFilterRead,
  revalidateNativeOwnerFilter,
  revalidateOwnerFilterDisclosure,
  withNativeOwnerFilterSource,
  sameOwnerFilterSource,
} from './owner-filter-native-binding.ts';
import { NativeCollectionWork } from './collection-source-work.ts';
import { retainNativeOwnerFilterPopulation } from './owner-filter-native-closure.ts';
import { createCollectionSource, type PreparedCollectionSource } from './collection-source.ts';
import { requireMembersReservationBudget } from './members-preparation-cost.ts';
import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
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
  type AuthoritativeTime,
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
import {
  registerPositionedOperationalHistoryWork,
  reserveOperationalWorkTransfer,
  type OperationalWorkRegistration,
} from '../history/operational-work.ts';
import type { OperationalWorkOriginal, OperationalWorkTransfer } from '../history/operational-work-budget.ts';

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
export type PreparationDefinitionBasis = Readonly<{
  definition: PreparationDefinition;
  canonicalBasis: string;
  basisDigest: Uint8Array;
}>;

/** Normalize accepted definitions to their exact shared expansion before native deduplication. */
export function preparationDefinitionBases(
  ownerAccountId: string,
  collectionId: string,
  definitions: readonly PreparationDefinition[],
): readonly PreparationDefinitionBasis[] {
  const unique = new Map<string, PreparationDefinitionBasis>();
  for (const input of definitions) {
    const prepared = prepareBasis(ownerAccountId, collectionId, structuredClone(input));
    const canonicalBasis = prepared.basis;
    const basisDigest = prepared.digest;
    const digestKey = basisDigest.toString('hex');
    const existing = unique.get(digestKey);
    if (existing && existing.canonicalBasis !== canonicalBasis) throw new ProblemError('unsupported_query');
    if (!existing)
      unique.set(digestKey, {
        definition: {
          filter: prepared.filter,
          sort: prepared.sort,
          release: { digest: prepared.releaseDigest, value: prepared.release },
        },
        canonicalBasis,
        basisDigest,
      });
  }
  return [...unique.values()];
}

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
export type MembersPreparationHistory = Readonly<{
  registration: OperationalWorkRegistration;
  resolve: OperationalWorkTransfer;
  verify: OperationalWorkTransfer;
  receive: OperationalWorkTransfer;
  replay: OperationalWorkTransfer;
  retirement: OperationalWorkTransfer;
}>;
export interface MembersPreparation {
  /** One Collection's distinct definitions, bounded by the common-page read authority. */
  reserve(
    actor: Actor,
    collectionId: string,
    definitions: readonly PreparationDefinition[],
    options?: { deadline?: number; history?: OperationalWorkOriginal; runtime?: boolean },
  ): Promise<
    Readonly<{
      episodes: readonly PreparingEpisode[];
      intent: PreparationIntent | null;
      history?: MembersPreparationHistory;
    }>
  >;
  /** Only the admitted reader calls this after an actual read; duplicate preparation does not touch LRU. */
  touch(actor: Actor, locator: PreparationLocator, options?: { deadline?: number }): Promise<boolean>;
  /** Called inside the registered step's fenced operational transaction; locks survive to its commit. */
  admitStep(tx: OperationalTransaction, locator: PreparationLocator): Promise<boolean>;
  /** Exact retained meaning on the admitted client; never Source or result authority. */
  readRetainedDefinition(
    tx: OperationalTransaction,
    locator: PreparationLocator,
  ): Promise<PreparationDefinition | null>;
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

/** Recover only the exact admitted definition, using the immutable release owned by Semantic.
 * The lookup digest is checked before release I/O; neither it nor the retained bytes grants Source authority.
 */
export async function restorePreparationDefinition(
  ownerAccountId: string,
  collectionId: string,
  retained: Readonly<{ canonicalBasis: string; basisDigest: Uint8Array }>,
  loadRelease: (digest: string) => Promise<FilterRelease | null>,
): Promise<PreparationDefinition> {
  const canonicalBasis = retained.canonicalBasis;
  let parts: unknown;
  try {
    if (
      typeof canonicalBasis !== 'string' ||
      Buffer.byteLength(canonicalBasis) > 196_608 ||
      retained.basisDigest.byteLength !== 32 ||
      !createHash('sha256').update(canonicalBasis).digest().equals(Buffer.from(retained.basisDigest))
    )
      throw unsupported();
    parts = JSON.parse(canonicalBasis);
    if (
      !Array.isArray(parts) ||
      parts.length !== 6 ||
      parts[0] !== BASIS_VERSION ||
      parts[1] !== ownerAccountId ||
      parts[2] !== collectionId ||
      (parts[4] !== 'id' && parts[4] !== 'ordinal') ||
      typeof parts[5] !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(parts[5]) ||
      canonicalize(parts) !== canonicalBasis
    )
      throw unsupported();
  } catch {
    throw unsupported();
  }
  const tuple = parts as [number, string, string, FilterDocument, PreparationDefinition['sort'], string];
  const release = await loadRelease(tuple[5]);
  if (!release) throw new ProblemError('dependency_unavailable');
  // Reapply shared admission and recompute the whole key. This also checks the actual release bytes
  // against their digest and refuses a stored filter that is no longer its own accepted expansion.
  const basis = prepareBasis(ownerAccountId, collectionId, {
    filter: tuple[3],
    sort: tuple[4],
    release: { digest: tuple[5], value: release },
  });
  if (basis.basis !== canonicalBasis) throw unsupported();
  return {
    filter: basis.filter,
    sort: basis.sort,
    release: { digest: basis.releaseDigest, value: basis.release },
  };
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
      // Metadata reservation remains independent of funded result production.
      if (options.runtime) requireMembersReservationBudget();

      const identity = principalCommandIdentity(actor);
      if (identity.principal.kind !== 'account' || identity.principal.id !== actor.accountId) throw notFound();
      const byBasis = new Map<string, Basis>();
      const requestOrder = preparationDefinitionBases(actor.accountId, collectionId, definitions).map((item) => {
        const digest = Buffer.from(item.basisDigest);
        const key = digest.toString('hex');
        byBasis.set(
          key,
          Object.freeze({
            basis: item.canonicalBasis,
            digest,
            filter: item.definition.filter,
            sort: item.definition.sort,
            releaseDigest: item.definition.release.digest,
            release: item.definition.release.value,
          }),
        );
        return key;
      });

      const deadline = options.deadline ?? options.history?.deadline ?? deadlineFor(DEFAULT_REQUEST_DEADLINE_MS);
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
          kind: options.history ? 'library.membersPreparation' : 'library.membersPreparation.reserve',
          accounts: [identity.principal.id],
          workClient: config.workClient,
          authorization,
          deadline,
          clock,
          ...(options.history ? { operationalHistory: options.history } : {}),
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
            // A mixed batch must not evict an episode it is about to return. Duplicates remain
            // read-only: protecting them for this admission does not advance their LRU time.
            // The owner has at most 32 live headers, so skipping these exact keys remains bounded.
            const retainedIds = [...found.values()].map((row) => row.episode_id);
            const lru = (
              await tx.query<{ episode_id: string }>(
                `SELECT episode_id::text FROM library.members_preparation
                 WHERE route=$1 AND owner_account_id=$2 AND state='live'
                   AND NOT (episode_id=ANY($4::uuid[]))
                 ORDER BY last_read_at ASC,episode_id ASC LIMIT $3 FOR UPDATE`,
                [route, actor.accountId, need, retainedIds],
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
          if (options.history) {
            // Register the actual newly retained bytes and the same native enqueue. Reservation metadata
            // remains preparing; History provenance neither captures Source nor authorizes a result.
            const registration = await registerPositionedOperationalHistoryWork(
              tx,
              {
                route,
                ownerAccountId: actor.accountId,
                collectionId,
                episodes: newKeys
                  .map((key) => ({
                    collectionId,
                    episodeId: ids.get(key)!,
                    reservedIncarnation: collection.incarnation,
                    reservedGeneration: collection.generation,
                    canonicalBasis: byBasis.get(key)!.basis,
                    basisDigest: key,
                  }))
                  .sort((a, b) => a.episodeId.localeCompare(b.episodeId)),
                retired: input.cleanup,
              },
              intent,
            );
            const history: MembersPreparationHistory = Object.freeze({
              registration,
              resolve: reserveOperationalWorkTransfer(tx, 'resolve'),
              verify: reserveOperationalWorkTransfer(tx, 'verify'),
              receive: reserveOperationalWorkTransfer(tx, 'receive'),
              replay: reserveOperationalWorkTransfer(tx, 'replay'),
              retirement: reserveOperationalWorkTransfer(tx, 'retirement'),
            });
            return { episodes, intent, history };
          }
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

    async readRetainedDefinition(tx, locator) {
      if (!hasLiveOperationalTransaction(tx)) return null;
      const resources = currentOperationalResources(tx);
      if (
        resources.pool !== config.pool ||
        resources.workClient !== config.workClient ||
        resources.mode !== 'work-step'
      )
        return null;
      if ((await service.admitStep(tx, locator)) !== true) return null;
      const [retained] = (
        await tx.query<{ canonicalBasis: string; basisDigest: Buffer }>(
          `SELECT canonical_basis AS "canonicalBasis",basis_digest AS "basisDigest"
           FROM library.members_preparation
           WHERE route=$1 AND owner_account_id=$2 AND collection_id=$3 AND episode_id=$4 AND state='live'`,
          [locator.route, locator.ownerAccountId, locator.collectionId, locator.episodeId],
        )
      ).rows;
      if (!retained) return null;
      return restorePreparationDefinition(locator.ownerAccountId, locator.collectionId, retained, (digest) =>
        readRelease(tx, digest),
      );
    },

    async readWorkDefinition(tx, locator) {
      if (!(await service.readRetainedDefinition(tx, locator))) return null;
      // Immutable meaning and a locator cannot supply the producer's missing Source declaration or authority.
      throw new ProblemError('dependency_unavailable', {
        detail: 'members-preparation-source-authority-unavailable',
      });
    },
  };
  return service;
}

/** Canonical definition identity only; never current Source authority. */
export function preparationBasis(owner: string, collection: string, definition: PreparationDefinition): string {
  return prepareBasis(owner, collection, definition).basis;
}
export const validPreparationLocator = validLocator;
const denied = () => new ProblemError('not_found');
function keyFor(actor: Actor, collectionId: string) {
  if (actor.kind !== 'account') throw denied();
  const route = routeOf(actor.accountId);
  if (route === null || routeOf(collectionId) !== route) throw denied();
  return { route, owner_account_id: actor.accountId, collection_id: collectionId };
}
function at(tx: OperationalTransaction): string {
  const time = commandTime(tx);
  if (!time) throw new TypeError('Preparation requires native operational time');
  return authoritativeTimeValue(time);
}
/** Exact native step binding; no Actor or reusable disclosure grant. */
export async function lockPreparationStep(
  tx: OperationalTransaction,
  locator: PreparationLocator,
): Promise<string | null> {
  return (await readPreparationStep(tx, locator))?.basis ?? null;
}

/** Retained metadata under the SAME actual admission as MembersPreparation.admitStep. No read permission. */
export async function readPreparationStep(tx: OperationalTransaction, locator: PreparationLocator) {
  if (!validPreparationLocator(locator) || !hasLiveOperationalTransaction(tx)) return null;
  const resources = currentOperationalResources(tx);
  if (
    resources.mode !== 'work-step' ||
    resources.partition !== partitionOf(locator.route) ||
    resources.accounts.length !== 1 ||
    resources.accounts[0] !== locator.ownerAccountId
  )
    return null;
  const row = await step.run(tx, {
    route: locator.route,
    owner_account_id: locator.ownerAccountId,
    collection_id: locator.collectionId,
    episode_id: locator.episodeId,
    at: at(tx),
  });
  if (!row || row.incarnation === null) return null;
  return { ...row, incarnation: row.incarnation };
}

/** Current native Scope70 metadata, read on the live admitted owner client; never an allow token. */
export async function readPreparationScope(
  tx: OperationalTransaction,
  locator: PreparationLocator,
): Promise<IdentityScopeObservation | null> {
  if (!(await readPreparationStep(tx, locator))) return null;
  const row = await nativeSource.run(tx, {
    route: locator.route,
    owner_account_id: locator.ownerAccountId,
    collection_id: locator.collectionId,
  });
  if (!row?.captureId || row.committedRevision === null) return null;
  const identity = preparationSourceIdentity(locator, row);
  if (!identity) return null;
  return {
    key: { source: { kind: 'library', identity }, scopeId: 'collection-source' },
    captureId: row.captureId,
    committedRevision: BigInt(row.committedRevision),
  };
}

/** Current native Source and complete Scope metadata on this live client, independently of selected data. */
export async function readPreparationSource(tx: OperationalTransaction, locator: PreparationLocator) {
  const state = await readPreparationStep(tx, locator);
  if (!state) return null;
  const row = await nativeSource.run(tx, {
    route: locator.route,
    owner_account_id: locator.ownerAccountId,
    collection_id: locator.collectionId,
  });
  if (
    !row?.captureId ||
    row.committedRevision === null ||
    row.incarnation === null ||
    !row.basisDigest ||
    !row.identityDigest ||
    row.incarnation !== state.incarnation ||
    row.generation !== state.generation
  )
    return null;
  const identity = preparationSourceIdentity(locator, row);
  if (!identity) return null;
  const source: CollectionSourceObservation = {
    route: locator.route,
    collectionId: locator.collectionId,
    incarnation: row.incarnation,
    revision: row.revision,
    authority: { kind: 'curated' },
    stamp: { partition: partitionOf(locator.route), epoch: row.epoch, position: BigInt(row.position) },
    basis: {
      digest: row.basisDigest,
      identity: { digest: row.identityDigest },
      query: null,
      profilePins: row.releaseDigest ? [row.releaseDigest] : [],
      projection: null,
    },
  };
  const scope: IdentityScopeObservation = {
    key: { source: { kind: 'library', identity }, scopeId: 'collection-source' },
    captureId: row.captureId,
    committedRevision: BigInt(row.committedRevision),
  };
  return { source, scope };
}

/** Native JSON is only a locator. Compare its full shape with the same-client current source columns. */
function preparationSourceIdentity(
  locator: PreparationLocator,
  row: NonNullable<Awaited<ReturnType<typeof nativeSource.run>>>,
): NativeSourceIdentity | null {
  if (!row.incarnation || !row.receivingEpoch || !row.effectKey) return null;
  const identity = {
    route: locator.route,
    collectionId: locator.collectionId,
    accountId: locator.ownerAccountId,
    incarnation: row.incarnation,
    generation: row.generation,
    scope: 'curated' as const,
    ownerEpoch: row.epoch,
    receivingEpoch: row.receivingEpoch,
    effectKey: row.effectKey,
  };
  return isDeepStrictEqual(row.identity, identity) ? identity : null;
}

export async function readPreparationOwnerFence(
  tx: OperationalTransaction,
  locator: PreparationLocator,
  definition: PreparationDefinition,
): Promise<string | null> {
  if (!compileCurrentOwnerFilter(definition.filter).leaves.some((leaf) => leaf.kind === 'owner')) return null;
  const row = await ownerFence.run(tx, { route: locator.route, account_id: locator.ownerAccountId });
  if (!row) throw new ProblemError('dependency_unavailable');
  return row.generation;
}

/** Native association/currentness inside a genuine selected apply, never the expired request handoff.
 * The installed selected producer still refuses final Source/physical completion after the owned body.
 */
export async function checkMembersPreparationCompletion(
  tx: OperationalTransaction,
  locator: PreparationLocator,
): Promise<
  | Readonly<{ status: 'obsolete' }>
  | Readonly<{
      status: 'unavailable';
      operand: 'selected-runtime-final-source-physical-authority-unavailable';
    }>
> {
  if (!(await readPreparationStep(tx, locator))) return { status: 'obsolete' };
  const association = await original.run(tx, {
    route: locator.route,
    owner_account_id: locator.ownerAccountId,
    collection_id: locator.collectionId,
    episode_id: locator.episodeId,
  });
  if (!association) return { status: 'obsolete' };
  // SelectedInvocation owns the fresh, nonrenewable executor admission and native result.
  // Its finishSelectedEpisode currently refuses complete with this exact operand. Native
  // exhaustion/association cannot replace the missing complete Source/physical authority.
  return { status: 'unavailable', operand: 'selected-runtime-final-source-physical-authority-unavailable' };
}

export type PreparationStepState = NonNullable<Awaited<ReturnType<typeof readPreparationStep>>>;

type ReaderDependencies = { pool: Pool; access: Access; tokens: KeyRing; clock?: KernelClock; routeKey?: Uint8Array };
type ReadBinding = Readonly<{
  at: AuthoritativeTime;
  source: CollectionSourceObservation;
  scope: IdentityScopeObservation;
  ownerFence: string | null;
  native: OwnerFilterReadBinding;
  admission: CollectionMemberAdmission;
  prepared: PreparedCollectionSource;
  work: NativeCollectionWork;
}>;
type ReadInput = Readonly<{
  actor: Actor;
  collectionId: string;
  definition: PreparationDefinition;
  deadline: number;
}>;

/** Owned ordinary-reader binding; an episode, admission, old observation or index row is never authority.
 * The actual Search reader must capture current formula/original+terminal/excluded/order/population evidence.
 */
async function bindPreparationRead(
  deps: ReaderDependencies,
  input: ReadInput,
): Promise<Readonly<{ status: 'unavailable' }> | Readonly<{ status: 'bound'; binding: ReadBinding }>> {
  const release = await within(input.deadline, () =>
    readRelease(deps.pool, input.definition.release.digest, { composed: false }),
  );
  if (!release) return { status: 'unavailable' };
  const filter = admitFilter(parseFilter(input.definition.filter), release, { saved: true, owner: true });
  const admission = await admitSavedCollectionMemberQuery(
    deps,
    input.actor,
    { filter, sort: 'id', releaseDigest: input.definition.release.digest },
    {},
    input.deadline,
  );
  if (admission.releaseDigest !== input.definition.release.digest) return { status: 'unavailable' };
  const bound = await bindOwnerFilterRead(deps, input.actor, input.collectionId, admission, input.deadline);
  if (bound.status !== 'bound') return bound;
  const native = bound.binding;
  try {
    const saved = nativeOwnerFilterBinding(native);
    if (!saved) throw new ProblemError('dependency_unavailable');
    const work = new NativeCollectionWork(native.input.allowance, input.deadline);
    const prepared = await withNativeOwnerFilterSource(native, work, () =>
      work.compose((allowance) => createCollectionSource(deps).prepare({ ...native.input, allowance })),
    );
    if (!sameOwnerFilterSource(saved.observation, prepared.source.observation)) throw new ProblemError('stale_cursor');
    await withNativeOwnerFilterSource(native, work, () => retainNativeOwnerFilterPopulation(native, work));
    return {
      status: 'bound',
      binding: {
        at: native.input.at,
        source: prepared.source.observation,
        scope: native.scope,
        ownerFence: saved.ownerFence,
        native,
        admission,
        prepared: prepared.source,
        work,
      },
    };
  } catch (error) {
    releaseNativeOwnerFilterRead(native);
    throw error;
  }
}
async function revalidatePreparationRead(
  deps: ReaderDependencies,
  input: ReadInput,
  binding: ReadBinding,
  subjects: readonly string[],
): Promise<Readonly<{ status: 'unavailable' }> | Readonly<{ status: 'current'; subjects: readonly string[] }>> {
  const { native, prepared, work, admission } = binding;
  return withNativeOwnerFilterSource(native, work, async () => {
    const source = createCollectionSource(deps);
    const disclosed: string[] = [];
    for (const subjectId of subjects) {
      const membership = await work.compose((allowance) =>
        source.containsSubject({ ...native.input, source: prepared, subjectId, allowance }),
      );
      if (!sameOwnerFilterSource(binding.source, membership.observation)) throw new ProblemError('stale_cursor');
      if (membership.result === 'not_proven') return { status: 'unavailable' };
      if (!membership.result) continue;
      const closure = await readOwnerFilterCandidateClosure(native, prepared, subjectId, work);
      if (closure.status !== 'complete') return { status: 'unavailable' };
      const control = work.reserve({
        candidateKeys: 0,
        nativeRows: 0,
        identityMetadataRows: 0,
        emptySeeks: 0,
        nativePoints: 1,
        witnessKeys: 0,
        statements: 3,
        bytes: 256,
      });
      control.dispatch();
      let match;
      try {
        match = await withReadTransaction(deps.pool, (client) =>
          readOwnerFilterCandidate(deadlineClient(client, input.deadline), admission, closure.closure, work),
        );
      } finally {
        control.settle();
      }
      if (match === 'not_proven') return { status: 'unavailable' };
      if (match) disclosed.push(subjectId);
    }
    const final = await work.compose((allowance) => source.prepare({ ...native.input, allowance }));
    if (!sameOwnerFilterSource(binding.source, final.source.observation)) throw new ProblemError('stale_cursor');
    await revalidateOwnerFilterDisclosure(native, work);
    return { status: 'current', subjects: disclosed };
  });
}

/** Complete observation equality includes excluded and order population. No native capability is deserialized. */
export function preparationObservation(
  source: CollectionSourceObservation,
  scope: IdentityScopeObservation,
  ownerFence: string | null = null,
): string {
  const value = canonicalize({
    ownerFence,
    source: { ...source, stamp: { ...source.stamp, position: source.stamp.position.toString() } },
    scope: { ...scope, committedRevision: scope.committedRevision.toString() },
  });
  if (typeof value !== 'string' || Buffer.byteLength(value) > 4096) throw unsupported();
  return value;
}

export type PreparedMembersRead =
  | Readonly<{ status: 'unavailable' }>
  | Readonly<{ status: 'preparing'; locator: PreparationLocator | null }>
  | Readonly<{
      status: 'ready';
      locator: PreparationLocator;
      subjects: readonly string[];
      next: string | null;
      revalidate(): Promise<void>;
      release(): void;
    }>;

/** Pure retained-result read. Its caller may choose ONE successful-read touch after the whole composed read.
 * Candidate rows supply order only. The native reader revalidates every authority before any complete page.
 */
export async function readPreparedMembers(
  deps: ReaderDependencies,
  input: ReadInput,
  options: { limit?: number; cursor?: string | null } = {},
): Promise<PreparedMembersRead> {
  const key = keyFor(input.actor, input.collectionId);
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ProblemError('invalid_request');
  const candidateLimit = Math.min(100, 2 * limit + 2);
  const basis = preparationBasis(key.owner_account_id, input.collectionId, input.definition);
  const digest = createHash('sha256').update(basis).digest();
  const binding: ListCursorBinding = {
    route: 'GET /v1/collections/{collectionId}/members',
    viewer: key.owner_account_id,
    query: {
      collectionId: input.collectionId,
      preparation: digest.toString('hex'),
      sort: input.definition.sort,
      limit,
    },
  };
  let after = '0';
  let cursorEpisode: string | null = null;
  let cursorObservation: string | null = null;
  let cursorEpoch: number | null = null;
  if (options.cursor !== undefined && options.cursor !== null) {
    const cursor = await decodeListCursor(deps.tokens, binding, options.cursor, (deps.clock ?? systemClock)());
    if (!cursor.ok || cursor.after.length !== 3) throw new ProblemError('invalid_cursor');
    const [episode, observation, position] = cursor.after;
    if (
      typeof episode !== 'string' ||
      routeOf(episode) !== key.route ||
      typeof observation !== 'string' ||
      typeof position !== 'string' ||
      !/^[1-9][0-9]{0,18}$/.test(position) ||
      BigInt(position) > 9223372036854775807n
    )
      throw new ProblemError('invalid_cursor');
    cursorEpisode = episode;
    cursorObservation = observation;
    cursorEpoch = cursor.epoch;
    after = position;
  }
  const current = await bindPreparationRead(deps, input);
  if (current.status !== 'bound') return { status: 'unavailable' };
  let retainedBinding = false;
  try {
    const { source, scope, at: time } = current.binding;
    if (source.collectionId !== input.collectionId || source.route !== key.route || scope.key.source.kind !== 'library')
      throw new TypeError('Foreign prepared members read');
    const identity = scope.key.source.identity;
    if (
      identity.scope !== 'curated' ||
      identity.accountId !== key.owner_account_id ||
      identity.collectionId !== input.collectionId ||
      identity.route !== key.route ||
      identity.incarnation !== source.incarnation
    )
      throw new TypeError('Foreign prepared members scope');
    if (cursorEpoch !== null && cursorEpoch !== source.stamp.epoch) throw new ProblemError('stale_cursor');
    const observation = preparationObservation(source, scope, current.binding.ownerFence);
    const observationDigest = createHash('sha256').update(observation).digest('hex');
    const read = await withReadTransaction(deps.pool, async (client) => {
      const query = deadlineClient(client, input.deadline);
      const [header] = await readHeader.run(query, { ...key, digest, at: authoritativeTimeValue(time) });
      if (!header) return null;
      if (header.basis !== basis) throw unsupported();
      if (cursorEpisode !== null && (cursorEpisode !== header.episodeId || cursorObservation !== observationDigest))
        throw new ProblemError('stale_cursor');
      const locator: PreparationLocator = {
        route: key.route,
        ownerAccountId: key.owner_account_id,
        collectionId: input.collectionId,
        episodeId: header.episodeId,
      };
      if (
        header.observation !== observation ||
        header.incarnation !== source.incarnation ||
        header.generation !== identity.generation
      )
        return { header, locator, rows: null };
      // Independent native original validation in this reader's snapshot, not a stored Boolean.
      if (!header.complete) return { header, locator, rows: null };
      if (
        !header.associated ||
        !(await original.run(query, { ...key, episode_id: header.episodeId })) ||
        !(await completionResult.run(query, { ...key, episode_id: header.episodeId }))
      )
        return { header, locator, rows: null, completionMissing: true };
      const rows = await readResults.run(query, { ...key, episode_id: header.episodeId, after, limit: candidateLimit });
      return { header, locator, rows };
    });
    if (!read) {
      if (cursorEpisode !== null) throw new ProblemError('stale_cursor');
      return { status: 'preparing', locator: null };
    }
    if (read.header.failure !== null) return { status: 'unavailable' };
    if ('completionMissing' in read && read.completionMissing) return { status: 'unavailable' };
    if (!read.header.associated || !read.header.complete) return { status: 'preparing', locator: read.locator };
    if (!read.rows) return { status: 'preparing', locator: read.locator };
    const disclosed = await revalidatePreparationRead(
      deps,
      input,
      current.binding,
      read.rows.map((row) => row.subjectId),
    );
    if (disclosed.status !== 'current') return { status: 'unavailable' };
    // The native result is a current ordered subsequence, never a caller-side evaluator or new canonical matcher.
    let index = 0;
    for (const subject of disclosed.subjects) {
      while (index < read.rows.length && read.rows[index]!.subjectId !== subject) index++;
      if (index === read.rows.length) throw new TypeError('Foreign or unordered prepared disclosure');
      index++;
    }
    const exhausted = read.header.complete && read.rows.length < candidateLimit;
    if (disclosed.subjects.length < limit && !exhausted) return { status: 'preparing', locator: read.locator };
    const subjects = disclosed.subjects.slice(0, limit);
    const last = subjects.at(-1);
    const position = last ? read.rows.find((row) => row.subjectId === last)!.position : after;
    const next =
      exhausted && disclosed.subjects.length <= limit
        ? null
        : await encodeListCursor(
            deps.tokens,
            binding,
            { epoch: source.stamp.epoch, after: [read.locator.episodeId, observationDigest, position] },
            (deps.clock ?? systemClock)(),
          );
    const revalidate = async () => {
      const final = await revalidatePreparationRead(deps, input, current.binding, subjects);
      if (
        final.status !== 'current' ||
        final.subjects.length !== subjects.length ||
        final.subjects.some((subject, index) => subject !== subjects[index])
      )
        throw new ProblemError('dependency_unavailable');
    };
    retainedBinding = true;
    return {
      status: 'ready',
      locator: read.locator,
      subjects,
      next,
      revalidate,
      release: () => releaseNativeOwnerFilterRead(current.binding.native),
    };
  } finally {
    if (!retainedBinding) releaseNativeOwnerFilterRead(current.binding.native);
  }
}

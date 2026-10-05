import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  activateHead,
  authorizeManager,
  claimLease,
  digest,
  fenceLease,
  inAccess,
  recordReceipt,
  replayReceipt,
  requireRecoveryOpen,
  RecommendationConflict,
  RecommendationDenied,
  RecommendationMissing,
  RecommendationRestart,
  RecommendationStale,
  RecommendationUnavailable,
  type ManageContext,
  type ReceiptKey,
} from '../recommendation/derived-generation.ts';
import type { ReadPosition } from '../work/read-session.ts';
import { READ_BASIS_RETENTION_MS } from '../read-basis/retention.ts';
import {
  DISCOVERY_COST,
  type DiscoveryBasis,
  type DiscoveryRow,
  type OwnedDiscoveryBasis,
  type ProjectedWork,
} from './contract.ts';
import {
  discoveryAutomation,
  DISCOVERY_SERVICE_PRINCIPAL,
  type DiscoveryAutomation,
} from './automation.ts';
import { DISCOVERY_SOURCE_PROFILE } from './profile.ts';
import { readDiscoveryRefreshHealth } from './refresh-health.ts';
import { DISCOVERY_DELTA_COST } from './changes.ts';
import {
  discoveryWriter,
  replaceDiscoveryWorks,
  rollbackDiscoveryVersion,
  repairAbandonedDiscoveryVersion,
  discoveryStorageReusable,
} from './versions.ts';

type DiscoveryOperator = ManageContext | DiscoveryAutomation;

export interface DiscoveryGeneration {
  generation_id: string;
  scope: DiscoveryBasis['scope'];
  realm: string | null;
  context: string | null;
  principal_id: string | null;
  source_epoch: string;
  source_sequence: string;
  access_revision: string;
  recovery_generation: string;
  checkpoint: string;
  complete: boolean;
  state: string;
  work_count: string;
  active_head: string | null;
  changed_works: string[] | null;
  source_profile?: string | null;
  storage_generation?: string | null;
  storage_version?: string;
  covered_sequence?: string;
  covered_access_revision?: string;
  catchup_works?: string[];
  rebuild_pending?: boolean;
}
/** Bind the immutable physical cut once; $1 is a storage root, $2 its version.
 * A retained generation must never inherit its root's newer live rows. */
export const discoveryStorage = (
  row: Pick<DiscoveryGeneration, 'generation_id' | 'storage_generation' | 'storage_version'>,
) => [row.storage_generation ?? row.generation_id, row.storage_version ?? '0'] as const;

export interface DiscoveryReadGeneration extends DiscoveryGeneration {
  stale: boolean;
}
const basisOf = (row: DiscoveryGeneration): OwnedDiscoveryBasis => ({
  scope: row.scope,
  realm: row.realm,
  context: row.context,
  owner: row.principal_id,
});
export const discoveryScopeKey = (basis: OwnedDiscoveryBasis) =>
  digest(['discovery-standing-mean-v1', basis]);

export const DISCOVERY_SELECTED_TERM_COST = { terms: DISCOVERY_COST.pageSize, queries: 1 } as const;
export const discoverySelectedTermsSql = `SELECT term, concept, work_count::text FROM access.discovery_terms($1,$2)
  WHERE generation_id = $1 AND term = ANY($3::text[]) LIMIT ${DISCOVERY_SELECTED_TERM_COST.terms}`;

/** A Condition page reads at most `window` recent rows per drive term, checks each
 * with at most `groups + 1` primary-key probes, then loads at most `pageSize` payloads. */
export const DISCOVERY_CONDITION_COST = {
  driveTerms: 8,
  groups: 8,
  groupTerms: 32,
  excludedTerms: 32,
  window: 60,
  pageSize: DISCOVERY_COST.pageSize,
  queries: 2,
} as const;

/** Terms a Work's entries must and must not carry, beside the drive terms it is reached by. */
export interface DiscoveryCondition {
  drive: string[];
  groups: string[][];
  excluded: string[];
}

/** Seeks per drive term, each Work checked by `(generation_id, work, work_type, term)` probes. */
export function discoveryConditionSql(
  groups: number,
  excluded: boolean,
  continuation: boolean,
  sort: 'recent' | 'top-rated' = 'recent',
): string {
  const order = sort === 'recent' ? 'recent_order' : 'rating_order';
  const rated = sort === 'top-rated' ? ' AND e.rating_count > 0' : '';
  // A scalar LIMIT keeps this correlated: EXISTS may become a hashed SubPlan
  // that reads an entire term population when retained history changes costs.
  const probe = (parameter: number) => `coalesce((SELECT true FROM access.discovery_entries($1,$2) x
    WHERE x.generation_id = $1 AND x.work = d.work AND x.work_type = $3 AND x.term = ANY($${parameter}::text[])
    LIMIT 1),false)`;
  const first = continuation ? 8 : 6;
  const checks = [
    ...Array.from({ length: groups }, (_, index) => probe(first + index)),
    ...(excluded ? [`NOT ${probe(first + groups)}`] : []),
  ];
  return `SELECT d.work, d.${order}::text AS order_key, d.term, ${checks.join(' AND ') || 'true'} AS matched
    FROM unnest($4::text[]) AS drive(term) CROSS JOIN LATERAL (
      SELECT e.work, e.${order}, e.term FROM access.discovery_entries($1,$2) e
      WHERE e.generation_id = $1 AND e.work_type = $3 AND e.term = drive.term${rated}
        ${continuation ? `AND (e.${order}, e.work COLLATE "C") > ($6::numeric, $7::text COLLATE "C")` : ''}
      ORDER BY e.${order}, e.work COLLATE "C" LIMIT $5) d`;
}
export const discoveryConditionPayloadSql = `SELECT e.work, e.payload FROM access.discovery_entries($1,$2) e
  JOIN unnest($4::text[], $5::text[]) AS k(work, term) ON e.work = k.work AND e.term = k.term
  WHERE e.generation_id = $1 AND e.work_type = $3`;

// Ordered, limited Work probes prevent a small high-degree generation from
// becoming a population scan. Two rows preserve the ambiguity rejection.
export const discoveryResourceCardPayloadSql = `SELECT cuts.id::text AS generation_id, e.work, jsonb_build_object(
  'primaryCredits', payload->'primaryCredits', 'rating', payload->'rating') AS payload
  FROM unnest($1::uuid[], $2::uuid[], $3::bigint[]) AS cuts(id, root, version)
  CROSS JOIN unnest($4::text[]) AS k(work) CROSS JOIN LATERAL (
    SELECT payload, work FROM access.discovery_entries(cuts.root, cuts.version)
    WHERE work=k.work AND work_type='' AND term=''
    ORDER BY entry_version DESC LIMIT 2) e`;

type SeekPosition = { key: string; work: string };
const integerKey = /^-?\d+$/;
const keyAfter = (left: string, right: string) =>
  left !== right &&
  (integerKey.test(left) && integerKey.test(right)
    ? BigInt(left) > BigInt(right)
    : Number(left) > Number(right));
const beyond = (a: SeekPosition, b: SeekPosition) =>
  keyAfter(a.key, b.key) || (a.key === b.key && a.work > b.work);
export interface ConditionRow {
  work: string;
  order_key: string;
  term: string;
  matched: boolean;
}

/**
 * The page a Condition seek decides. A drive term whose window filled may have
 * rows past its last one, so no row beyond the earliest such last row is
 * decided: the page ends there and `next` resumes after it, even when fewer
 * than `limit` Works matched. A Work reached by several drive terms counts once.
 */
export function decideConditionPage(
  drive: readonly string[],
  scanned: readonly ConditionRow[],
  window: number,
  limit: number,
): { page: ConditionRow[]; next: SeekPosition | null } {
  let horizon: SeekPosition | null = null;
  for (const term of drive) {
    const rows = scanned.filter((item) => item.term === term);
    const last = rows.at(-1);
    if (rows.length === window && last) {
      const bound = { key: last.order_key, work: last.work };
      if (!horizon || beyond(horizon, bound)) horizon = bound;
    }
  }
  const decided = new Map<string, ConditionRow>();
  for (const item of scanned) {
    if (
      !decided.has(item.work) &&
      !(horizon && beyond({ key: item.order_key, work: item.work }, horizon))
    ) {
      decided.set(item.work, item);
    }
  }
  const matched = [...decided.values()]
    .filter((item) => item.matched)
    .sort((a, b) =>
      beyond({ key: a.order_key, work: a.work }, { key: b.order_key, work: b.work }) ? 1 : -1,
    );
  const page = matched.slice(0, limit);
  const last = page.at(-1);
  return {
    page,
    next: matched.length > limit && last ? { key: last.order_key, work: last.work } : horizon,
  };
}

export function discoverySeekSql(sort: 'recent' | 'top-rated', continuation: boolean): string {
  const key = sort === 'recent' ? 'recent_order' : 'rating_order';
  return `SELECT work, ${key}::text AS order_key, payload FROM access.discovery_entries($1,$2)
    WHERE generation_id = $1 AND work_type = $3 AND term = $4
      ${sort === 'top-rated' ? 'AND rating_count > 0' : ''}
      ${continuation ? `AND (${key}, work COLLATE "C") > ($6::numeric, $7::text COLLATE "C")` : ''}
    ORDER BY ${key}, work COLLATE "C" LIMIT $5`;
}

/** The existing (generation,type,term,recent_order,work) index supplies each
 * positive posting list. Merge only <=8*(64+1) rows; dedup precedes the final
 * page limit so overlapping interpretations cannot skip or repeat a Work.
 * https://www.postgresql.org/docs/18/indexes-multicolumn.html */
export function discoveryResourceSeekSql(continuation: boolean, scoped = true): string {
  const after = continuation
    ? 'AND (e.recent_order, e.work COLLATE "C") > ($6::numeric, $7::text COLLATE "C")'
    : '';
  if (!scoped)
    return `SELECT e.work, e.recent_order::text AS order_key FROM access.discovery_entries($1,$2) e
    WHERE e.generation_id=$1 AND e.work_type=$3 AND e.term=$4 ${after}
    ORDER BY e.recent_order, e.work COLLATE "C" LIMIT $5`;
  return `SELECT work, recent_order::text AS order_key FROM (
    SELECT DISTINCT ON (d.work) d.work, d.recent_order
    FROM unnest($4::text[]) AS drive(term) CROSS JOIN LATERAL (
      SELECT e.work, e.recent_order FROM access.discovery_entries($1,$2) e
      WHERE e.generation_id=$1 AND e.work_type=$3 AND e.term=drive.term
        ${after}
      ORDER BY e.recent_order, e.work COLLATE "C" LIMIT $5
    ) d ORDER BY d.work, d.recent_order
  ) merged ORDER BY recent_order, work COLLATE "C" LIMIT $5`;
}
interface ResourceSeekRow {
  work: string;
  order_key: string;
}

/** Folded Access source revision, whether a source change has committed since
 * the last fold, and the recovery generation, all read in one snapshot. */
export interface DiscoverySourceFence {
  revision: string;
  changed: boolean;
  generation: string;
}

/** Source writers append change rows and never touch the fence row, so this
 * read takes no lock: a vote neither waits for it nor makes it wait. */
export async function sourceFence(client: PoolClient): Promise<DiscoverySourceFence> {
  await requireRecoveryOpen(client);
  const row = (
    await client.query<DiscoverySourceFence>(`SELECT d.revision::text,
    EXISTS (SELECT 1 FROM access.discovery_source_change) AS changed, f.generation::text
    FROM access.discovery_source_fence d CROSS JOIN access.recovery_fence f WHERE d.id AND f.id`)
  ).rows[0];
  if (!row) throw new RecommendationUnavailable('Discovery source fence is unavailable');
  return row;
}

/** Registration folds every committed change into the revision its basis
 * records. A change still uncommitted keeps its row and outdates that basis. */
export async function foldSourceFence(client: PoolClient): Promise<DiscoverySourceFence> {
  await requireRecoveryOpen(client);
  const row = (
    await client.query<DiscoverySourceFence>(`SELECT d.basis::text AS revision, d.changed,
    f.generation::text FROM access.fold_discovery_source_changes() d
    CROSS JOIN access.recovery_fence f WHERE f.id`)
  ).rows[0];
  if (!row) throw new RecommendationUnavailable('Discovery source fence is unavailable');
  return row;
}

/** Judgment contexts whose changes reach a basis; '' marks a scope-wide change.
 * Mine projects no classifications, so no judgment reaches it. */
export const discoverySourceContexts = (basis: Pick<DiscoveryBasis, 'scope' | 'realm'>) =>
  basis.scope === 'mine' ? [''] : ['', 'global', ...(basis.realm ? [basis.realm] : [])];

/** A refresh resolves at most as many judged Statements to Works as a delta
 * may carry events; more rebuild the population instead. */
export const DISCOVERY_SOURCE_KEY_COST = {
  statements: DISCOVERY_DELTA_COST.events,
  queries: 1,
} as const;

/** The fence and the Access changes after one basis that reach it, in one
 * snapshot. `changed`: a reaching change awaits its fold. `wide`: a scope- or
 * context-wide change was folded after the basis. `statements`: at most the
 * requested number of judged Statements folded after it. */
export interface DiscoverySourceChanges extends DiscoverySourceFence {
  wide: boolean;
  statements: string[];
}

/** The folded Access revision a generation covers: its basis, or a later one
 * a refresh acknowledged after finding no reaching change in its population. */
export const discoveryAccessBasis = (
  row: Pick<DiscoveryGeneration, 'access_revision' | 'covered_access_revision'>,
) => row.covered_access_revision ?? row.access_revision;

/** Takes no lock. Fold first when the result must account for committed rows. */
export async function sourceChanges(
  client: PoolClient,
  basis: Pick<DiscoveryBasis, 'scope' | 'realm'>,
  revision: string,
  statements = 0,
): Promise<DiscoverySourceChanges> {
  await requireRecoveryOpen(client);
  return sourceChangesWithin(client, basis, revision, statements);
}

/** `sourceChanges` in a transaction that already holds the open recovery fence. */
export async function sourceChangesWithin(
  client: PoolClient,
  basis: Pick<DiscoveryBasis, 'scope' | 'realm'>,
  revision: string,
  statements = 0,
): Promise<DiscoverySourceChanges> {
  const row = (
    await client.query<DiscoverySourceChanges>(
      `SELECT d.revision::text, f.generation::text,
    EXISTS (SELECT 1 FROM access.discovery_source_change c WHERE c.context_key = ANY($1::text[])) AS changed,
    EXISTS (SELECT 1 FROM access.discovery_source_key k WHERE k.context_key = ANY($1::text[])
      AND k.statement = '' AND k.revision > $2::bigint) AS wide,
    ARRAY(SELECT k.statement FROM access.discovery_source_key k WHERE k.context_key = ANY($1::text[])
      AND k.statement <> '' AND k.revision > $2::bigint LIMIT $3) AS statements
    FROM access.discovery_source_fence d CROSS JOIN access.recovery_fence f WHERE d.id AND f.id`,
      [discoverySourceContexts(basis), revision, statements],
    )
  ).rows[0];
  if (!row) throw new RecommendationUnavailable('Discovery source fence is unavailable');
  return row;
}

/** No Access change reaches the basis: read with at least one Statement. */
export const discoveryAccessCurrent = (changes: DiscoverySourceChanges) =>
  !changes.changed && !changes.wide && !changes.statements.length;

function assertPosition(row: DiscoveryGeneration, position: ReadPosition) {
  if (row.source_epoch !== position.dataEpoch || row.source_sequence !== position.sequence) {
    throw new RecommendationRestart('Discovery graph changed');
  }
}
/** Only recovery or a wide change closes a build. Judged Statements after its
 * basis do not: it completes against that basis and the next refresh projects
 * their Works, so a stream of votes cannot restart it forever. */
async function assertFence(client: PoolClient, row: DiscoveryGeneration) {
  const since = await sourceChanges(client, row, discoveryAccessBasis(row));
  if (since.wide || since.generation !== row.recovery_generation) {
    throw new RecommendationRestart('Discovery Access basis changed');
  }
}
export async function generation(client: PoolClient, id: string): Promise<DiscoveryGeneration> {
  const row = (
    await client.query<DiscoveryGeneration>(
      `SELECT d.*, g.state, h.revision::text AS active_head,
    d.source_sequence::text, d.access_revision::text, d.work_count::text, d.storage_version::text,
    coalesce(c.sequence,d.source_sequence)::text AS covered_sequence,
    coalesce(c.access_revision,d.access_revision)::text AS covered_access_revision,
    g.input_manifest->>'sourceProfile' AS source_profile
    FROM access.discovery_generation d JOIN access.derived_generation g ON g.id = d.generation_id
    LEFT JOIN access.discovery_coverage c ON c.generation_id=d.generation_id
    LEFT JOIN access.derived_generation_head h ON h.family = 'discovery' AND h.scope_key = g.scope_key
    WHERE d.generation_id = $1`,
      [id],
    )
  ).rows[0];
  if (!row) throw new RecommendationMissing('Discovery generation is unavailable');
  return row;
}
async function operatorPrincipal(
  client: PoolClient,
  context: DiscoveryOperator,
  scope: DiscoveryBasis['scope'],
  owner?: string | null,
) {
  if (discoveryAutomation in context) {
    const principal = context[discoveryAutomation];
    if (scope !== 'mine') {
      if (principal) throw new RecommendationDenied('Shared refresh cannot select a principal');
      return DISCOVERY_SERVICE_PRINCIPAL;
    }
    if (
      !principal ||
      (owner && owner !== principal) ||
      !(
        await client.query('SELECT id FROM access.principal WHERE id = $1 AND active FOR SHARE', [
          principal,
        ])
      ).rowCount
    ) {
      throw new RecommendationDenied('Refresh principal is unavailable');
    }
    return principal;
  }
  if (scope !== 'mine') return authorizeManager(client, context);
  // A person may rebuild only their own private rating population. The acting
  // Agent cannot select another principal, including for organization personas.
  const principal = (
    await client.query<{ id: string }>(
      `SELECT id FROM access.principal
    WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
      [context.principal.issuer, context.principal.subject],
    )
  ).rows[0]?.id;
  if (!principal) throw new RecommendationDenied('Discovery principal is inactive');
  if (owner && owner !== principal) {
    throw new RecommendationMissing('Discovery generation is unavailable');
  }
  return principal;
}
const manager = (client: PoolClient, context: DiscoveryOperator, row: DiscoveryGeneration) =>
  operatorPrincipal(client, context, row.scope, row.principal_id);

/** Durable generation/checkpoint protocol; no method in the GET path builds or
 * aggregates. Advances use bounded batches and release their step lease. */
export class DiscoveryProjection {
  constructor(private readonly pool: Pool) {}

  refreshHealth() {
    return readDiscoveryRefreshHealth(this.pool);
  }

  async register(
    context: DiscoveryOperator,
    basis: DiscoveryBasis,
    position: ReadPosition,
    key: ReceiptKey,
    /** `access` is the folded revision through which `works` include the Works
     * of every judged Statement that reaches the basis. Without it, no such
     * Statement may have been folded after the prior generation's basis. */
    reuse?: { generation: string; works: string[]; access?: string },
  ) {
    return inAccess(this.pool, async (client) => {
      await requireRecoveryOpen(client);
      const principal = await operatorPrincipal(client, context, basis.scope);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `discovery-receipt:${principal}:${key.idempotencyKey}`,
      ]);
      const replay = await replayReceipt(client, principal, key, 'build');
      if (replay) return { ...(await generation(client, replay.generation_id)), replayed: true };
      const fence = await foldSourceFence(client);
      const owned: OwnedDiscoveryBasis = {
        ...basis,
        owner: basis.scope === 'mine' ? principal : null,
      };
      const scope = discoveryScopeKey(owned);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `discovery:${scope}`,
      ]);
      const pending = (
        await client.query(
          `SELECT id FROM access.derived_generation
        WHERE family = 'discovery' AND scope_key = $1 AND state = 'building' LIMIT 1`,
          [scope],
        )
      ).rows[0];
      if (pending)
        throw new RecommendationConflict('A discovery build already exists for this basis');
      const id = randomUUID();
      const manifest = {
        basis: owned,
        position,
        access: fence,
        sourceProfile: DISCOVERY_SOURCE_PROFILE,
      };
      await client.query(
        `INSERT INTO access.derived_generation
        (id, family, scope_key, input_digest, input_manifest, lease_expires_at)
        VALUES ($1, 'discovery', $2, $3, $4, clock_timestamp())`,
        [id, scope, digest(manifest), manifest],
      );
      if (reuse) {
        const prior = await generation(client, reuse.generation);
        const covered = discoveryAccessBasis(prior);
        const since = await sourceChangesWithin(client, prior, covered, reuse.access ? 0 : 1);
        if (
          prior.state !== 'ready' ||
          prior.source_epoch !== position.dataEpoch ||
          since.wide ||
          (reuse.access
            ? BigInt(reuse.access) < BigInt(covered) ||
              BigInt(reuse.access) > BigInt(fence.revision)
            : since.statements.length > 0) ||
          prior.recovery_generation !== fence.generation ||
          prior.source_profile !== DISCOVERY_SOURCE_PROFILE ||
          digest(basisOf(prior)) !== digest(owned) ||
          reuse.works.length > 2000 ||
          BigInt(prior.covered_sequence ?? prior.source_sequence) > BigInt(position.sequence)
        ) {
          throw new RecommendationRestart('Discovery reuse basis changed');
        }
        // A failed/expired unactivated delta may have closed older intervals.
        // Repair it under the same scope lock before reusing its version number.
        if (
          (
            await client.query(
              `SELECT 1 FROM access.discovery_generation d JOIN access.derived_generation g ON g.id=d.generation_id
          WHERE d.storage_generation=$1 AND d.storage_version>$2 AND g.state IN ('building','ready') LIMIT 1`,
              [prior.storage_generation ?? prior.generation_id, prior.storage_version ?? '0'],
            )
          ).rowCount
        ) {
          throw new RecommendationConflict('A newer discovery storage version already exists');
        }
        await repairAbandonedDiscoveryVersion(client, prior);
        if (!(await discoveryStorageReusable(client, prior)))
          throw new RecommendationRestart('Discovery storage has a later snapshot');
        await client.query(
          `INSERT INTO access.discovery_generation
          (generation_id,scope,realm,context,principal_id,source_epoch,source_sequence,access_revision,recovery_generation,
            storage_generation,storage_version,changed_works,work_count)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            id,
            basis.scope,
            basis.realm,
            basis.context,
            owned.owner,
            position.dataEpoch,
            position.sequence,
            reuse.access ?? fence.revision,
            fence.generation,
            prior.storage_generation ?? prior.generation_id,
            (BigInt(prior.storage_version ?? '0') + 1n).toString(),
            JSON.stringify(reuse.works),
            prior.work_count,
          ],
        );
      } else
        await client.query(
          `INSERT INTO access.discovery_generation
        (generation_id, scope, realm, context, principal_id, source_epoch, source_sequence,
         access_revision, recovery_generation) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            basis.scope,
            basis.realm,
            basis.context,
            owned.owner,
            position.dataEpoch,
            position.sequence,
            fence.revision,
            fence.generation,
          ],
        );
      await client.query(
        'INSERT INTO access.discovery_coverage (generation_id,sequence) VALUES ($1,$2)',
        [id, position.sequence],
      );
      await client.query(
        `INSERT INTO access.derived_generation_input
        (generation_id, source, data_epoch, pinned_sequence, checkpoint_sequence)
        VALUES ($1, 'main-graph', $2, $3, $3)`,
        [id, position.dataEpoch, position.sequence],
      );
      await recordReceipt(client, principal, key, {
        action: 'build',
        generation_id: id,
        outcome: 'succeeded',
        head_revision: null,
      });
      return { ...(await generation(client, id)), replayed: false };
    });
  }

  async view(context: DiscoveryOperator, id: string) {
    return inAccess(this.pool, async (client) => {
      await requireRecoveryOpen(client);
      const row = await generation(client, id);
      await manager(client, context, row);
      return row;
    });
  }

  async beginStep(context: DiscoveryOperator, id: string, checkpoint: string) {
    return inAccess(this.pool, async (client) => {
      await requireRecoveryOpen(client);
      const row = await generation(client, id);
      await manager(client, context, row);
      await assertFence(client, row);
      if (row.checkpoint !== checkpoint || row.complete)
        throw new RecommendationStale('Build checkpoint changed');
      const lease = await claimLease(client, id, DISCOVERY_COST.leaseMs);
      return { row, lease };
    });
  }

  async commitStep(
    context: DiscoveryOperator,
    id: string,
    lease: string,
    checkpoint: string,
    result: { after: string; complete: boolean; item: ProjectedWork | null },
    position: ReadPosition,
  ) {
    return this.commitBatch(
      context,
      id,
      lease,
      checkpoint,
      { ...result, items: result.item ? [result.item] : [] },
      position,
    );
  }

  async releaseStep(context: DiscoveryOperator, id: string, lease: string) {
    await inAccess(this.pool, async (client) => {
      await requireRecoveryOpen(client);
      await manager(client, context, await generation(client, id));
      await client.query(
        `UPDATE access.derived_generation SET lease_expires_at = clock_timestamp()
        WHERE id = $1 AND lease_epoch = $2 AND state = 'building'`,
        [id, lease],
      );
    });
  }

  async commitBatch(
    context: DiscoveryOperator,
    id: string,
    lease: string,
    checkpoint: string,
    result: {
      after: string;
      complete: boolean;
      items: ProjectedWork[];
      nextPass?: { works: string[] | null; position: ReadPosition };
    },
    position: ReadPosition,
  ) {
    return inAccess(this.pool, async (client) => {
      await requireRecoveryOpen(client);
      await fenceLease(client, id, lease, DISCOVERY_COST.leaseMs);
      const row = await generation(client, id);
      await manager(client, context, row);
      assertPosition(row, position);
      await assertFence(client, row);
      if (row.checkpoint !== checkpoint || (result.after <= checkpoint && !result.complete)) {
        throw new RecommendationStale('Build checkpoint changed');
      }
      if (
        result.items.length > DISCOVERY_COST.buildWorks ||
        new Set(result.items.map((item) => item.work)).size !== result.items.length ||
        result.items.some((item) => row.changed_works && !row.changed_works.includes(item.work))
      ) {
        throw new RecommendationUnavailable('Discovery batch exceeds its bound');
      }
      if (
        result.nextPass &&
        (result.nextPass.position.dataEpoch !== row.source_epoch ||
          BigInt(result.nextPass.position.sequence) <= BigInt(row.source_sequence) ||
          (result.nextPass.works?.length ?? 0) > 2000)
      )
        throw new RecommendationStale('Discovery catch-up cut changed');
      await discoveryWriter(client, row);
      const replaced = await replaceDiscoveryWorks(
        client,
        row,
        row.changed_works?.filter((work) => work > checkpoint && work <= result.after) ??
          result.items.map((item) => item.work),
        result.items,
      );
      const entries = result.items.flatMap((item) => {
        if (
          item.work <= checkpoint ||
          item.work > result.after ||
          item.types.length > 3 ||
          item.classifications.length > DISCOVERY_COST.termsPerWork ||
          new Set(item.classifications.map((term) => term.sense)).size !==
            item.classifications.length ||
          item.primaryCredits.length > DISCOVERY_COST.primaryCredits
        ) {
          throw new RecommendationUnavailable('Discovery projection exceeds its fanout');
        }
        return ['', ...item.types].flatMap((type) =>
          [null, ...item.classifications].map((term) => ({
            work: item.work,
            recent: item.recentOrder,
            count: item.rating?.count ?? 0,
            sum: item.rating?.sum ?? 0,
            type,
            term: term?.sense ?? '',
            payload: {
              revision: item.revision,
              mainVersion: item.mainVersion,
              types: item.types,
              rating: item.rating,
              classification: term,
              primaryCredits: item.primaryCredits,
              classifications: item.classifications.slice(0, DISCOVERY_COST.cardTags),
            },
          })),
        );
      });
      if (entries.length) {
        await client.query(
          `INSERT INTO access.discovery_entry
          (generation_id, work, work_type, term, recent_order, rating_count, rating_sum, payload, entry_version)
          SELECT $1,e.work,e.type,e.term,e.recent::numeric,e.count,e.sum,e.payload,$3
          FROM jsonb_to_recordset($2::jsonb) e(work text, type text, term text, recent text, count smallint, sum smallint, payload jsonb)`,
          [row.storage_generation ?? id, JSON.stringify(entries), row.storage_version ?? '0'],
        );
      }
      const complete = result.complete && !result.nextPass;
      await client.query(
        `UPDATE access.discovery_generation SET checkpoint=$2, complete=$3,
        work_count=work_count+$4 WHERE generation_id=$1`,
        [id, result.after, complete, result.items.length - replaced],
      );
      if (result.nextPass?.works === null) {
        // A named scope-wide change requires another full pass, after finishing
        // this population. A staged delta first releases its borrowed intervals.
        await rollbackDiscoveryVersion(client, row);
        await client.query("SELECT set_config('rezics.discovery_mode','rebuild',true)");
        if (!row.storage_generation)
          for (const table of [
            'discovery_entry',
            'discovery_term_count',
            'discovery_concept_count',
          ]) {
            await client.query(`DELETE FROM access.${table} WHERE generation_id=$1`, [id]);
          }
      }
      if (result.nextPass)
        await client.query(
          `UPDATE access.discovery_generation SET checkpoint='',changed_works=$2,
        catchup_works='[]',rebuild_pending=false,source_sequence=$3,
        storage_generation=CASE WHEN $2::jsonb IS NULL THEN NULL ELSE storage_generation END,
        storage_version=CASE WHEN $2::jsonb IS NULL THEN 0 ELSE storage_version END,
        work_count=CASE WHEN $2::jsonb IS NULL THEN 0 ELSE work_count END WHERE generation_id=$1`,
          [
            id,
            result.nextPass.works === null ? null : JSON.stringify(result.nextPass.works),
            result.nextPass.position.sequence,
          ],
        );
      await client.query(
        `UPDATE access.derived_generation_input SET snapshot_cursor = $2,
        snapshot_complete = $3 WHERE generation_id = $1 AND source = 'main-graph'`,
        [id, complete || result.nextPass ? null : result.after, complete],
      );
      if (complete)
        await client.query(
          `UPDATE access.derived_generation SET state = 'ready',
        lease_expires_at = NULL, ready_at = clock_timestamp(),
        validation_digest = $2 WHERE id = $1`,
          [id, digest({ basis: row, last: result.after })],
        );
      else
        await client.query(
          `UPDATE access.derived_generation SET lease_expires_at = clock_timestamp()
        WHERE id = $1`,
          [id],
        );
      return generation(client, id);
    });
  }

  async cancel(context: DiscoveryOperator, id: string) {
    return inAccess(this.pool, async (client) => {
      await requireRecoveryOpen(client);
      const row = await generation(client, id);
      await manager(client, context, row);
      if (!['building', 'cancelled'].includes(row.state))
        throw new RecommendationStale('Generation cannot be cancelled');
      if (row.state === 'building') await rollbackDiscoveryVersion(client, row);
      await client.query(
        `UPDATE access.derived_generation SET state = 'cancelled',
        lease_expires_at = NULL, finished_at = clock_timestamp(), failure_reason = 'manager-cancelled'
        WHERE id = $1 AND state = 'building'`,
        [id],
      );
      return generation(client, id);
    });
  }

  async activate(
    context: DiscoveryOperator,
    id: string,
    expected: string | null,
    position: ReadPosition,
    key: ReceiptKey,
  ) {
    return inAccess(this.pool, async (client) => {
      await requireRecoveryOpen(client);
      const row = await generation(client, id);
      if (row.source_profile !== DISCOVERY_SOURCE_PROFILE) {
        throw new RecommendationRestart('Discovery source profile changed');
      }
      const principal = await manager(client, context, row);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `discovery-receipt:${principal}:${key.idempotencyKey}`,
      ]);
      // A completed population is immutable at its source cut. Concurrent
      // writes affect freshness, not eligibility to activate that pinned cut.
      const fence = await sourceFence(client);
      if (
        row.source_epoch !== position.dataEpoch ||
        row.recovery_generation !== fence.generation ||
        BigInt(row.source_sequence) > BigInt(position.sequence)
      ) {
        throw new RecommendationRestart('Discovery recovery basis changed');
      }
      if (
        (
          await client.query(
            `SELECT 1 FROM access.derived_generation_head
        WHERE family = 'discovery' AND active_generation = $1`,
            [id],
          )
        ).rowCount &&
        !(await replayReceipt(client, principal, key, 'activate'))
      ) {
        throw new RecommendationStale('Discovery generation is already active');
      }
      return activateHead(client, principal, key, id, expected);
    });
  }

  async active(
    basis: OwnedDiscoveryBasis,
    position: ReadPosition,
    pinned?: string,
  ): Promise<DiscoveryReadGeneration> {
    return inAccess(this.pool, async (client) => {
      await requireRecoveryOpen(client);
      const head = (
        await client.query<{ active_generation: string }>(
          `SELECT active_generation::text
        FROM access.derived_generation_head WHERE family = 'discovery' AND scope_key = $1`,
          [discoveryScopeKey(basis)],
        )
      ).rows[0];
      if (!head) throw new RecommendationUnavailable('Discovery has no active generation');
      const row = await generation(client, pinned ?? head.active_generation).catch(
        (error: unknown) => {
          // A retained cursor expires identically before and after its physical
          // projection metadata is purged. It never becomes a missing resource.
          if (pinned && error instanceof RecommendationMissing)
            throw new RecommendationRestart('Discovery generation expired');
          throw error;
        },
      );
      // Activation may replace the head between these READ COMMITTED statements.
      // The captured generation is also a pin on a first page, not a 503 race.
      const retained =
        row.state !== 'ready' &&
        (
          await client.query(
            `SELECT id FROM access.derived_generation
        WHERE id = $1 AND state IN ('superseded', 'expired')
          AND finished_at > clock_timestamp() - make_interval(secs => $2::double precision / 1000)`,
            [row.generation_id, READ_BASIS_RETENTION_MS],
          )
        ).rowCount === 1;
      if (row.state !== 'ready' && !retained) {
        if (pinned) throw new RecommendationRestart('Discovery generation expired');
        throw new RecommendationUnavailable('Discovery basis is unavailable');
      }
      if (digest(basisOf(row)) !== digest(basis)) {
        throw new RecommendationUnavailable('Discovery basis is unavailable');
      }
      // A judged Statement anywhere in a reaching context makes the page stale
      // until a refresh projects or acknowledges it.
      const since = await sourceChanges(client, row, discoveryAccessBasis(row), 1);
      if (row.source_epoch !== position.dataEpoch || row.recovery_generation !== since.generation) {
        if (pinned) throw new RecommendationRestart('Discovery recovery basis expired');
        throw new RecommendationUnavailable('Discovery recovery basis is unavailable');
      }
      return {
        ...row,
        stale:
          row.source_profile !== DISCOVERY_SOURCE_PROFILE ||
          (row.covered_sequence ?? row.source_sequence) !== position.sequence ||
          !discoveryAccessCurrent(since) ||
          row.state !== 'ready' ||
          head.active_generation !== row.generation_id,
      };
    });
  }

  async page(
    row: DiscoveryGeneration,
    sort: 'recent' | 'top-rated',
    type: string,
    term: string,
    limit: number,
    after?: { key: string; work: string },
  ) {
    return inAccess(this.pool, async (client) => {
      // Ranking rows are immutable. Source writes invalidate freshness, not the
      // population; recovery remains a hard boundary for every page.
      const fence = await sourceFence(client);
      if (fence.generation !== row.recovery_generation)
        throw new RecommendationRestart('Discovery recovery basis expired');
      if (!Number.isInteger(limit) || limit < 1 || limit > DISCOVERY_COST.pageSize) {
        throw new RecommendationUnavailable('Discovery page is out of bounds');
      }
      const result = (
        await client.query<DiscoveryRow>(discoverySeekSql(sort, !!after), [
          ...discoveryStorage(row),
          type,
          term,
          limit + 1,
          ...(after ? [after.key, after.work] : []),
        ])
      ).rows;
      if (Buffer.byteLength(JSON.stringify(result)) > DISCOVERY_COST.projectionBytes) {
        throw new RecommendationUnavailable('Discovery page exceeds its byte budget');
      }
      return result;
    });
  }

  /** Exact selected-Sense lookups on (generation_id, term), independent of popularity rank.
   * Absent rows mean zero only when the caller verifies the generation is fresh. */
  async selectedTerms(row: DiscoveryGeneration, terms: readonly string[]) {
    if (
      terms.length > DISCOVERY_SELECTED_TERM_COST.terms ||
      new Set(terms).size !== terms.length ||
      terms.some((term) => !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(term))
    ) {
      throw new RecommendationUnavailable('Selected term page is out of bounds');
    }
    return inAccess(this.pool, async (client) => {
      const fence = await sourceFence(client);
      if (fence.generation !== row.recovery_generation)
        throw new RecommendationRestart('Discovery recovery basis expired');
      return terms.length
        ? (
            await client.query<{ term: string; concept: string; work_count: string }>(
              discoverySelectedTermsSql,
              [...discoveryStorage(row), terms],
            )
          ).rows
        : [];
    });
  }

  /** The accepted Concepts of at most 64 Works, one primary-key range per Work: a Zone browse window's Tags. */
  async workTerms(row: DiscoveryGeneration, works: readonly string[]) {
    if (
      works.length > 64 ||
      new Set(works).size !== works.length ||
      works.some((work) => !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(work))
    ) {
      throw new RecommendationUnavailable('Work term batch is out of bounds');
    }
    const bound = works.length * DISCOVERY_COST.termsPerWork;
    return inAccess(this.pool, async (client) => {
      const fence = await sourceFence(client);
      if (fence.generation !== row.recovery_generation)
        throw new RecommendationRestart('Discovery recovery basis expired');
      if (!works.length) return [];
      const rows = (
        await client.query<{ work: string; term: string; concept: string }>(
          `
        SELECT work, term, payload->'classification'->>'concept' AS concept FROM access.discovery_entries($1,$2)
        WHERE generation_id = $1 AND work = ANY($3::text[]) AND work_type = '' AND term <> ''
        LIMIT ${bound + 1}`,
          [...discoveryStorage(row), works],
        )
      ).rows;
      if (rows.length > bound) throw new RecommendationUnavailable('Work terms exceed their bound');
      return rows;
    });
  }

  /**
   * One page of Works, newest first, whose entries meet a Condition: reached by a
   * drive term, carrying a term of every group and none excluded. Each drive term
   * reads at most `window` rows (`decideConditionPage`); `next` is null only
   * when the seeks were exhausted.
   */
  async conditionPage(
    row: DiscoveryGeneration,
    type: string,
    condition: DiscoveryCondition,
    limit: number,
    after?: SeekPosition,
    sort: 'recent' | 'top-rated' = 'recent',
  ) {
    const { drive, groups, excluded } = condition;
    const cost = DISCOVERY_CONDITION_COST;
    const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
    const allWorks = drive.length === 1 && drive[0] === '';
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > cost.pageSize ||
      !drive.length ||
      drive.length > cost.driveTerms ||
      new Set(drive).size !== drive.length ||
      groups.length > cost.groups ||
      groups.flat().length > cost.groupTerms ||
      excluded.length > cost.excludedTerms ||
      (!allWorks && drive.some((term) => !native.test(term))) ||
      [...groups.flat(), ...excluded].some((term) => !native.test(term))
    ) {
      throw new RecommendationUnavailable('Discovery Condition is out of bounds');
    }
    return inAccess(this.pool, async (client) => {
      const fence = await sourceFence(client);
      if (fence.generation !== row.recovery_generation)
        throw new RecommendationRestart('Discovery recovery basis expired');
      const scanned = (
        await client.query<ConditionRow>(
          discoveryConditionSql(groups.length, excluded.length > 0, !!after, sort),
          [
            ...discoveryStorage(row),
            type,
            drive,
            cost.window,
            ...(after ? [after.key, after.work] : []),
            ...groups,
            ...(excluded.length ? [excluded] : []),
          ],
        )
      ).rows;
      const { page, next } = decideConditionPage(drive, scanned, cost.window, limit);
      const payloads = page.length
        ? new Map(
            (
              await client.query<{ work: string; payload: DiscoveryRow['payload'] }>(
                discoveryConditionPayloadSql,
                [
                  ...discoveryStorage(row),
                  type,
                  page.map((item) => item.work),
                  page.map((item) => item.term),
                ],
              )
            ).rows.map((item) => [item.work, item.payload]),
          )
        : new Map<string, DiscoveryRow['payload']>();
      const rows: DiscoveryRow[] = page.map((item) => {
        const payload = payloads.get(item.work);
        if (!payload) throw new RecommendationUnavailable('Discovery Condition row is unavailable');
        return { work: item.work, order_key: item.order_key, payload };
      });
      if (Buffer.byteLength(JSON.stringify(rows)) > DISCOVERY_COST.projectionBytes) {
        throw new RecommendationUnavailable('Discovery page exceeds its byte budget');
      }
      return { rows, next };
    });
  }

  /** Which of `terms` the given Works carry on the wildcard type row. At most one primary-key probe batch. */
  async termMembership(
    row: DiscoveryGeneration,
    works: readonly string[],
    terms: readonly string[],
  ) {
    const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
    if (
      works.length > 64 ||
      terms.length > DISCOVERY_CONDITION_COST.groupTerms + DISCOVERY_CONDITION_COST.excludedTerms ||
      new Set(works).size !== works.length ||
      new Set(terms).size !== terms.length ||
      [...works, ...terms].some((value) => !native.test(value))
    ) {
      throw new RecommendationUnavailable('Discovery term membership is out of bounds');
    }
    if (!works.length || !terms.length) return [];
    return inAccess(this.pool, async (client) => {
      const fence = await sourceFence(client);
      if (fence.generation !== row.recovery_generation)
        throw new RecommendationRestart('Discovery recovery basis expired');
      return (
        await client.query<{ work: string; term: string }>(
          `SELECT work, term FROM access.discovery_entries($1,$2)
        WHERE generation_id = $1 AND work = ANY($3::text[]) AND work_type = '' AND term = ANY($4::text[])`,
          [...discoveryStorage(row), works, terms],
        )
      ).rows;
    });
  }

  /** Public query windows seek keys only. Card payloads are read separately for
   * delivered Works; no JSON payload is copied/sorted for rejected candidates. */
  async resourcePage(
    row: DiscoveryGeneration,
    limit: number,
    after?: { key: string; work: string },
    drive?: readonly string[],
    type = '',
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 64)
      throw new RecommendationUnavailable('Resource window exceeds its bound');
    if (
      drive &&
      (drive.length > DISCOVERY_CONDITION_COST.driveTerms ||
        new Set(drive).size !== drive.length ||
        drive.some((term) => !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(term)))
    )
      throw new RecommendationUnavailable('Resource drive exceeds its bound');
    if (drive?.length === 0) return [];
    return inAccess(this.pool, async (client) => {
      const fence = await sourceFence(client);
      if (fence.generation !== row.recovery_generation)
        throw new RecommendationRestart('Discovery recovery basis expired');
      return (
        await client.query<ResourceSeekRow>(discoveryResourceSeekSql(!!after, !!drive), [
          ...discoveryStorage(row),
          type,
          ...(drive ? [drive] : ['']),
          limit + 1,
          ...(after ? [after.key, after.work] : []),
        ])
      ).rows;
    });
  }

  async resourceMembership(row: DiscoveryGeneration, works: readonly string[]) {
    if (works.length > 64) throw new RecommendationUnavailable('Work membership exceeds its bound');
    if (!works.length) return new Set<string>();
    return inAccess(this.pool, async (client) => {
      await requireRecoveryOpen(client);
      return new Set(
        (
          await client.query<{ work: string }>(
            `SELECT work FROM access.discovery_entries($1,$2)
        WHERE generation_id=$1 AND work_type='' AND term='' AND work=ANY($3::text[])`,
            [...discoveryStorage(row), works],
          )
        ).rows.map((row) => row.work),
      );
    });
  }

  /** Exact primary-key probes of immutable, already bounded card payloads.
   * https://www.postgresql.org/docs/18/indexes-multicolumn.html
   * No LIMIT/aggregation over the Work's underlying credits or ratings. */
  async resourceCardPayloads(
    generations: readonly DiscoveryGeneration[],
    works: readonly string[],
  ) {
    if (generations.length > 2 || works.length > 64 || new Set(works).size !== works.length)
      throw new RecommendationUnavailable('Resource card projection batch exceeds its bound');
    return inAccess(this.pool, async (client) => {
      const fence = await sourceFence(client);
      if (generations.some((row) => row.recovery_generation !== fence.generation))
        throw new RecommendationRestart('Discovery recovery basis expired');
      const rows = (
        await client.query<{
          generation_id: string;
          work: string;
          payload: DiscoveryRow['payload'];
        }>(discoveryResourceCardPayloadSql, [
          generations.map((row) => row.generation_id),
          generations.map((row) => discoveryStorage(row)[0]),
          generations.map((row) => discoveryStorage(row)[1]),
          works,
        ])
      ).rows;
      if (
        rows.length > generations.length * works.length ||
        Buffer.byteLength(JSON.stringify(rows)) > DISCOVERY_COST.projectionBytes
      )
        throw new RecommendationUnavailable('Resource card payload exceeds its byte bound');
      const result = new Map(
        generations.map((row) => [row.generation_id, new Map<string, DiscoveryRow['payload']>()]),
      );
      for (const row of rows) {
        const own = result.get(row.generation_id);
        if (!own || own.has(row.work) || !works.includes(row.work))
          throw new RecommendationUnavailable('Resource card projection is ambiguous');
        own.set(row.work, row.payload);
      }
      return result;
    });
  }

  /** Indexed Concept counts are finalized once by the build, from term counts.
   * Zero-use Concepts are supplied separately by the public-name inventory. */
  async conceptCounts(row: DiscoveryGeneration, concepts: readonly string[]) {
    if (concepts.length > 64)
      throw new RecommendationUnavailable('Concept count batch exceeds its bound');
    return inAccess(this.pool, async (client) => {
      await requireRecoveryOpen(client);
      return (
        await client.query<{ concept: string; work_count: string }>(
          `SELECT concept, work_count::text FROM access.discovery_concepts($1,$2) WHERE concept=ANY($3::text[])`,
          [...discoveryStorage(row), concepts],
        )
      ).rows;
    });
  }
  async conceptPage(
    row: DiscoveryGeneration,
    limit: number,
    after?: { count: string; concept: string },
  ) {
    return inAccess(this.pool, async (client) => {
      await requireRecoveryOpen(client);
      return (
        await client.query<{ concept: string; work_count: string }>(
          `SELECT concept, work_count::text FROM access.discovery_concepts($1,$2)
          ${after ? 'WHERE (-work_count,concept) > (-$3::bigint,$4::text COLLATE "C")' : ''}
        ORDER BY -work_count,concept COLLATE "C" LIMIT $${after ? 5 : 3}`,
          [...discoveryStorage(row), ...(after ? [after.count, after.concept] : []), limit + 1],
        )
      ).rows;
    });
  }

  async popular(row: DiscoveryGeneration, limit: number) {
    return inAccess(this.pool, async (client) => {
      const fence = await sourceFence(client);
      if (fence.generation !== row.recovery_generation)
        throw new RecommendationRestart('Discovery recovery basis expired');
      if (!Number.isInteger(limit) || limit < 1 || limit > DISCOVERY_COST.pageSize) {
        throw new RecommendationUnavailable('Popular term page is out of bounds');
      }
      return (
        await client.query<{ term: string; concept: string; work_count: string }>(
          `
        SELECT term, concept, work_count::text FROM access.discovery_terms($1,$2) t
        WHERE generation_id = $1 ORDER BY t.work_count DESC, term COLLATE "C" LIMIT $3`,
          [...discoveryStorage(row), limit],
        )
      ).rows;
    });
  }
}

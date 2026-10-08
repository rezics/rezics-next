import { createHash, createHmac, type Hash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import {
  accessOutboxCoverage,
  accessStateTables,
  type AccessStateTables,
} from '../work/access-recovery-coverage.ts';
import {
  foldRowCoverage,
  scanOwnerTable,
  type OwnerTable,
  type RowCoverage,
} from '../work/pg-recovery-frontier.ts';
import {
  readRestoredGraphReleaseProof,
  RestoreLineageConflict,
  type RecoveryCoverage,
  type RestoredGraphReleaseExpectation,
} from '../work/restore-lineage.ts';

/**
 * Two immutable findings of the running outer restore operation bind its release
 * to the durable `:erasures` record. Both are HMAC-SHA256 under the recovery key,
 * so a finding written without that key does not verify. The first commits with
 * the retained qualification while both holds are closed; the second commits with
 * the Access opening and records a PROVEN transition, not an observation: the
 * full Access coverage before the captured-generation CAS equals the signed
 * authority, and the coverage after it equals that coverage plus exactly the one
 * `id`-only row each of the two source-change tables gains from the CAS.
 */
const QUALIFICATION = 'restore-qualification:';
const RELEASE = 'restore-release:';
/** The reviewed effects of the CAS: recovery_fence source triggers append one row per transaction. */
const INVALIDATIONS = [
  'access.discovery_source_change',
  'access.also_enjoyed_source_change',
] as const;
type Invalidation = (typeof INVALIDATIONS)[number];
/** Must equal the label `scanAccessTables` folds with; a difference refuses the release. */
const ACCESS_STATE_LABEL = 'access-state-v5';

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function mac(key: string, value: unknown): string {
  return createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
}

export interface ErasuresRecord {
  id: string;
  consumer: string;
  requestDigest: string;
  outcomeDigest: string;
  coverageGeneration: string;
  erasureEpoch: string | null;
  items: number;
  cuts: string;
}

/** The reconciled `:erasures` record, or null while none is committed. */
export async function readErasuresRecord(
  relay: Pool | PoolClient,
  operationId: string,
): Promise<ErasuresRecord | null> {
  const row = (
    await relay.query<{
      id: string;
      consumer: string;
      request_digest: string;
      outcome_digest: string;
      coverage_generation: string;
      erasure_epoch: string | null;
    }>(
      `SELECT id, consumer, request_digest, outcome_digest, coverage_generation::text,
      erasure_epoch::text FROM relay.owner_reconciliation
     WHERE operation_id = $1 AND kind = 'restore' AND state = 'reconciled'
       AND erasure_id IS NULL AND consumer IS NOT NULL AND outcome_digest IS NOT NULL
       AND coverage_generation IS NOT NULL`,
      [operationId],
    )
  ).rows[0];
  if (!row) return null;
  const items = (
    await relay.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM relay.owner_reconciliation_item WHERE reconciliation_id = $1',
      [row.id],
    )
  ).rows[0]!.count;
  const cuts = (
    await relay.query<{
      owner: string;
      data_epoch: string | null;
      sequence: string | null;
      coverage_digest: string;
    }>(
      `SELECT owner, data_epoch, sequence::text, coverage_digest
    FROM relay.owner_reconciliation_cut WHERE reconciliation_id = $1 ORDER BY owner`,
      [row.id],
    )
  ).rows;
  return {
    id: row.id,
    consumer: row.consumer,
    requestDigest: row.request_digest,
    outcomeDigest: row.outcome_digest,
    coverageGeneration: row.coverage_generation,
    erasureEpoch: row.erasure_epoch,
    items: Number(items),
    cuts: sha(cuts),
  };
}

export function qualificationRef(
  key: string,
  record: ErasuresRecord,
  capturedGeneration: string,
  expectation: RestoredGraphReleaseExpectation,
): string {
  return (
    QUALIFICATION + mac(key, ['restore-qualification-v1', record, capturedGeneration, expectation])
  );
}

/** The retained head and journal bound at release, read on the caller's relay client. */
async function frontier(relay: Pool | PoolClient, consumer: string) {
  const head =
    (
      await relay.query<{ generation: string; coverage_digest: string }>(
        `SELECT generation::text, coverage_digest FROM relay.recovery_coverage_head
     WHERE consumer = $1 FOR SHARE`,
        [consumer],
      )
    ).rows[0] ?? null;
  const journal = (
    await relay.query<{ epoch: string | null }>(
      'SELECT max(erasure_epoch)::text AS epoch FROM relay.erasure',
    )
  ).rows[0]!.epoch;
  return { head, journal };
}

export interface AccessCoverage {
  state: RowCoverage;
  outbox: RowCoverage;
}

/** Signed pre-release Access coverage of the independently current authority. */
function signedAccess(coverage: RecoveryCoverage): AccessCoverage {
  return {
    state: { count: coverage.accessStateCount, digest: coverage.accessStateDigest },
    outbox: { count: coverage.accessOutboxCount, digest: coverage.accessOutboxDigest },
  };
}

const sameCoverage = (left: RowCoverage, right: RowCoverage): boolean =>
  left.count === right.count && left.digest === right.digest;

function invalidationTable(name: Invalidation): OwnerTable {
  const [schema, table] = name.split('.') as [string, string];
  // Both are `id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY` and nothing else.
  return { name, schema, table, key: ['id'], keyTypes: ['bigint'], columns: [] };
}

const record = (key: readonly string[], body: string): string => JSON.stringify([key, body]) + '\n';

/** The Access coverage the CAS starts from, with the running row hashes of the invalidation tables. */
export interface ReleaseBasis {
  tables: AccessStateTables;
  outbox: RowCoverage;
  invalidations: Record<Invalidation, { hash: Hash; count: bigint; maximum: bigint }>;
}

/**
 * Pin the pre-release Access coverage on the locked release client, before the
 * CAS: it must equal the signed authority. Every invalidation row is also
 * streamed through the scanner's own per-row hash so the post-CAS digest can be
 * derived instead of observed.
 */
export async function captureReleaseBasis(
  accessPool: Pool,
  accessClient: PoolClient,
  coverage: RecoveryCoverage,
): Promise<ReleaseBasis> {
  const signed = signedAccess(coverage);
  const tables = await accessStateTables(accessPool, accessClient);
  const outbox = await accessOutboxCoverage(accessPool, accessClient);
  if (!sameCoverage(tables.state, signed.state) || !sameCoverage(outbox, signed.outbox)) {
    throw new RestoreLineageConflict('Access differs from the signed pre-release authority');
  }
  const invalidations = {} as ReleaseBasis['invalidations'];
  for (const name of INVALIDATIONS) {
    const hash = createHash('sha256');
    let count = 0n;
    let maximum = -1n;
    const scanned = await scanOwnerTable(accessClient, invalidationTable(name), (key, body) => {
      hash.update(record(key, body));
      count++;
      maximum = BigInt(key[0]!);
    });
    if (!tables.tables[name] || !sameCoverage(scanned, tables.tables[name]!)) {
      throw new RestoreLineageConflict(`Access invalidation table ${name} is not covered`);
    }
    invalidations[name] = { hash, count, maximum };
  }
  return { tables, outbox, invalidations };
}

export interface ReleaseTransition {
  pre: AccessCoverage;
  post: AccessCoverage;
  /** The two identity values the real CAS consumed; only these are read from the post-state. */
  identities: Record<Invalidation, string>;
}

/**
 * Prove, on the same transaction after the CAS, that the only Access change
 * since the signed pre-state is the fence reopening and one new row in each
 * invalidation table, and that the post coverage equals the derived one.
 */
export async function proveReleaseTransition(
  accessPool: Pool,
  accessClient: PoolClient,
  basis: ReleaseBasis,
  capturedGeneration: string,
): Promise<ReleaseTransition> {
  const fence = (
    await accessClient.query<{ open: boolean; generation: string }>(
      'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true',
    )
  ).rows[0];
  if (fence?.open !== true || fence.generation !== (BigInt(capturedGeneration) + 1n).toString()) {
    throw new RestoreLineageConflict(
      'Access is not open at the generation after the captured fence',
    );
  }
  const post = await accessStateTables(accessPool, accessClient);
  const outbox = await accessOutboxCoverage(accessPool, accessClient);
  const unexpected = (what: string) =>
    new RestoreLineageConflict(`Access changed beyond the captured-generation release (${what})`);
  if (post.catalogDigest !== basis.tables.catalogDigest) throw unexpected('catalog');
  if (!sameCoverage(outbox, basis.outbox)) throw unexpected('outbox');
  const expected: Record<string, RowCoverage> = {};
  const identities = {} as ReleaseTransition['identities'];
  for (const [name, coverage] of Object.entries(basis.tables.tables)) {
    if (!(INVALIDATIONS as readonly string[]).includes(name)) {
      if (!sameCoverage(post.tables[name] ?? { count: '', digest: '' }, coverage))
        throw unexpected(name);
      expected[name] = coverage;
    }
  }
  if (Object.keys(post.tables).length !== Object.keys(basis.tables.tables).length)
    throw unexpected('tables');
  for (const name of INVALIDATIONS) {
    const before = basis.invalidations[name];
    const derived = before.hash.copy();
    const retained = createHash('sha256');
    let retainedCount = 0n;
    const added: string[] = [];
    await scanOwnerTable(accessClient, invalidationTable(name), (key, body) => {
      if (BigInt(key[0]!) <= before.maximum) {
        retained.update(record(key, body));
        retainedCount++;
      } else {
        added.push(key[0]!);
        derived.update(record(key, body));
      }
    });
    // The pre rows are exactly the same rows, and the CAS added exactly one.
    if (
      retainedCount !== before.count ||
      retained.digest('hex') !== basis.tables.tables[name]!.digest ||
      added.length !== 1
    )
      throw unexpected(name);
    identities[name] = added[0]!;
    expected[name] = { count: (before.count + 1n).toString(), digest: derived.digest('hex') };
    if (!post.tables[name] || !sameCoverage(post.tables[name]!, expected[name]!))
      throw unexpected(name);
  }
  const derivedState = foldRowCoverage(
    ACCESS_STATE_LABEL,
    {
      tables: Object.keys(basis.tables.tables).map((name) => ({ name }) as OwnerTable),
      excluded: {},
      digest: basis.tables.catalogDigest,
    },
    expected,
  );
  if (!sameCoverage(derivedState, post.state)) throw unexpected('state digest');
  return {
    pre: { state: basis.tables.state, outbox: basis.outbox },
    post: { state: post.state, outbox },
    identities,
  };
}

function releaseMac(
  key: string,
  qualification: string,
  record: ErasuresRecord,
  capturedGeneration: string,
  authority: string,
  receipt: unknown,
  retained: unknown,
  transition: ReleaseTransition,
): string {
  return mac(key, [
    'restore-release-v2',
    qualification,
    record,
    capturedGeneration,
    authority,
    receipt,
    retained,
    transition,
  ]);
}

/** The finding carries the verified post coverage so a later reader compares live Access to it. */
function releaseReference(digest: string, transition: ReleaseTransition): string {
  const { post, identities } = transition;
  return (
    `${RELEASE}${digest}:${post.state.count}:${post.state.digest}:${post.outbox.count}:` +
    `${post.outbox.digest}:${identities[INVALIDATIONS[0]]}:${identities[INVALIDATIONS[1]]}`
  );
}

function parseRelease(
  reference: string,
): { digest: string; post: AccessCoverage; identities: ReleaseTransition['identities'] } | null {
  const match =
    /^restore-release:([0-9a-f]{64}):([0-9]+):([0-9a-f]{64}):([0-9]+):([0-9a-f]{64}):([0-9]+):([0-9]+)$/.exec(
      reference,
    );
  return match
    ? {
        digest: match[1]!,
        post: {
          state: { count: match[2]!, digest: match[3]! },
          outbox: { count: match[4]!, digest: match[5]! },
        },
        identities: {
          [INVALIDATIONS[0]]: match[6]!,
          [INVALIDATIONS[1]]: match[7]!,
        } as ReleaseTransition['identities'],
      }
    : null;
}

async function insertBinding(relay: PoolClient, outerId: string, reference: string): Promise<void> {
  await relay.query(
    `INSERT INTO relay.owner_reconciliation_item
      (reconciliation_id, ordinal, owner, item_kind, item_ref, disposition, evidence_digest)
    SELECT $1, coalesce(max(ordinal), 1) + 1, 'access', 'authority_fence', $2, 'matched', $3
    FROM relay.owner_reconciliation_item WHERE reconciliation_id = $1`,
    [outerId, reference, createHash('sha256').update(reference).digest('hex')],
  );
}

/** Bind the qualification inside the relay transaction that commits the `:erasures` record. */
export async function recordQualification(
  relay: PoolClient,
  key: string,
  outerId: string,
  erasures: ErasuresRecord,
  capturedGeneration: string,
  expectation: RestoredGraphReleaseExpectation,
): Promise<void> {
  await insertBinding(
    relay,
    outerId,
    qualificationRef(key, erasures, capturedGeneration, expectation),
  );
}

/** The latest binding of each kind recorded on the outer operation. */
export async function readBindings(
  relay: Pool | PoolClient,
  outerId: string,
): Promise<{ qualification: string | null; release: string | null }> {
  const latest = async (prefix: string) =>
    (
      await relay.query<{ item_ref: string }>(
        `SELECT item_ref FROM relay.owner_reconciliation_item
     WHERE reconciliation_id = $1 AND owner = 'access' AND item_kind = 'authority_fence'
       AND item_ref LIKE $2 AND disposition = 'matched' ORDER BY ordinal DESC LIMIT 1`,
        [outerId, prefix + '%'],
      )
    ).rows[0]?.item_ref ?? null;
  return { qualification: await latest(QUALIFICATION), release: await latest(RELEASE) };
}

/** Resume a recorded qualification: its record and bound cuts must still be exact. */
export async function requireQualification(
  relay: Pool | PoolClient,
  key: string,
  outerId: string,
  erasures: ErasuresRecord,
  capturedGeneration: string,
  expectation: RestoredGraphReleaseExpectation,
): Promise<void> {
  if (
    (await readBindings(relay, outerId)).qualification !==
    qualificationRef(key, erasures, capturedGeneration, expectation)
  ) {
    throw new RestoreLineageConflict(
      'durable restore qualification differs from the retained record',
    );
  }
}

/**
 * Record the proven transition before either owner commits. The finding is
 * refused unless the qualification finding verifies, the native release is
 * exactly the expected one and the retained head and journal are unchanged.
 */
export async function recordRelease(
  relay: PoolClient,
  key: string,
  fuseki: FusekiClient,
  outerId: string,
  erasures: ErasuresRecord,
  capturedGeneration: string,
  expectation: RestoredGraphReleaseExpectation,
  authority: string,
  transition: ReleaseTransition,
): Promise<void> {
  const qualification = qualificationRef(key, erasures, capturedGeneration, expectation);
  await requireQualification(relay, key, outerId, erasures, capturedGeneration, expectation);
  const proof = await readRestoredGraphReleaseProof(fuseki, expectation);
  if (!proof) throw new RestoreLineageConflict('native graph release evidence is unavailable');
  const retained = await frontier(relay, erasures.consumer);
  await insertBinding(
    relay,
    outerId,
    releaseReference(
      releaseMac(
        key,
        qualification,
        erasures,
        capturedGeneration,
        authority,
        proof.receipt,
        retained,
        transition,
      ),
      transition,
    ),
  );
}

/**
 * Complete a lost outer outcome after both owners committed. Read-only. The
 * release finding must verify under the recovery key against the durable
 * `:erasures` record, the exact native receipt, the retained head and journal
 * and the independently current authority; live Access must still equal the
 * coverage that finding recorded after its proven transition. Any difference is
 * a definitive conflict; nothing is held again, replayed or re-signed.
 */
export async function verifyReleasedRestore(input: {
  relay: PoolClient;
  fuseki: FusekiClient;
  key: string;
  outerId: string;
  erasuresOperationId: string;
  expectation: RestoredGraphReleaseExpectation;
  coverage: RecoveryCoverage;
  authority: string;
  capturedGeneration: string;
  requestDigests: readonly string[];
  live: () => Promise<AccessCoverage>;
}): Promise<void> {
  const { relay, fuseki, key, expectation, capturedGeneration } = input;
  const consumer = input.coverage.relay.consumer;
  const erasures = await readErasuresRecord(relay, input.erasuresOperationId);
  if (
    !erasures ||
    erasures.consumer !== consumer ||
    !input.requestDigests.includes(erasures.requestDigest)
  ) {
    throw new RestoreLineageConflict('restore completion has no matching retained erasure record');
  }
  const bound = await readBindings(relay, input.outerId);
  const qualification = qualificationRef(key, erasures, capturedGeneration, expectation);
  if (bound.qualification !== qualification) {
    throw new RestoreLineageConflict('restore completion differs from its durable qualification');
  }
  const release = bound.release ? parseRelease(bound.release) : null;
  if (!release)
    throw new RestoreLineageConflict('restore completion has no durable release binding');
  const proof = await readRestoredGraphReleaseProof(fuseki, expectation);
  if (!proof) throw new RestoreLineageConflict('native graph release evidence is unavailable');
  const retained = await frontier(relay, consumer);
  const transition: ReleaseTransition = {
    pre: signedAccess(input.coverage),
    post: release.post,
    identities: release.identities,
  };
  if (
    releaseReference(
      releaseMac(
        key,
        qualification,
        erasures,
        capturedGeneration,
        input.authority,
        proof.receipt,
        retained,
        transition,
      ),
      transition,
    ) !== bound.release
  ) {
    throw new RestoreLineageConflict('restore completion differs from its durable release binding');
  }
  const live = await input.live();
  if (
    !sameCoverage(live.state, release.post.state) ||
    !sameCoverage(live.outbox, release.post.outbox)
  ) {
    throw new RestoreLineageConflict(
      'Access differs from the coverage its release binding recorded',
    );
  }
}

import { createHash } from 'node:crypto';
import { types } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import type { AccountDiscoveryEnrollment } from '../access/account-discovery-reduction.ts';
import { publicFilterCreationConsumer } from './public-filter-creation-consumer.ts';
import { CommandUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';
import { discardConnection, withConnection } from '../database/pool.ts';

type Binding = Readonly<{
  bootstrap: string;
  registration: Readonly<{ partition: number; id: string }>;
  definition: string;
  /** Original Search encoding, not a caller-provided permission or cut. */
  consumer: string;
  accounts: boolean;
}>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const bigintMaximum = 9223372036854775807n;

/** Read only the fixed native fields. Do not invoke getters, enumerate arbitrary
 * extra keys, retain a nested caller object or accept coercible scalar objects.
 */
function scalarFields<T extends object>(input: T, keys: readonly (keyof T)[]): T {
  if (
    !input ||
    typeof input !== 'object' ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new TypeError('Baseline input must be plain native data');
  const snapshot = Object.create(null);
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(input, key);
    if (!field || !Object.hasOwn(field, 'value')) throw new TypeError('Baseline input must have own data fields');
    Object.defineProperty(snapshot, key, { value: field.value, enumerable: true });
  }
  return Object.freeze(snapshot) as T;
}

function snapshotBinding(input: Binding): Binding {
  const binding = scalarFields(input, ['bootstrap', 'registration', 'definition', 'consumer', 'accounts']);
  const registration = scalarFields(binding.registration, ['partition', 'id']);
  if (
    typeof binding.bootstrap !== 'string' ||
    !uuid.test(binding.bootstrap) ||
    typeof binding.definition !== 'string' ||
    !uuid.test(binding.definition) ||
    typeof binding.consumer !== 'string' ||
    binding.consumer.length === 0 ||
    typeof binding.accounts !== 'boolean' ||
    !Number.isInteger(registration.partition) ||
    registration.partition < 0 ||
    registration.partition > 4095 ||
    typeof registration.id !== 'string' ||
    registration.id.length === 0
  )
    throw new TypeError('Invalid native baseline binding');
  return Object.freeze({ ...binding, registration });
}

function snapshotEnrollment(input: AccountDiscoveryEnrollment): AccountDiscoveryEnrollment {
  const receipt = scalarFields(input, [
    'partition',
    'epoch',
    'revision',
    'claimRevision',
    'sourcePosition',
    'creationPosition',
    'enqueueRevision',
    'keyDigest',
    'receipt',
    'complete',
  ]);
  if (
    !Number.isInteger(receipt.partition) ||
    receipt.partition < 0 ||
    receipt.partition > 4095 ||
    !Number.isInteger(receipt.epoch) ||
    receipt.epoch < 0 ||
    receipt.epoch > 2147483647 ||
    typeof receipt.keyDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(receipt.keyDigest) ||
    !(receipt.receipt === null || (typeof receipt.receipt === 'string' && /^[0-9a-f]{64}$/.test(receipt.receipt))) ||
    typeof receipt.complete !== 'boolean'
  )
    throw new TypeError('Invalid native baseline enrollment');
  for (const key of ['revision', 'claimRevision', 'sourcePosition', 'creationPosition', 'enqueueRevision'] as const) {
    const value = receipt[key];
    if (typeof value !== 'bigint' || value < 0n || value > bigintMaximum)
      throw new TypeError('Invalid native baseline position');
  }
  return receipt;
}

async function transaction<T>(pool: Pool, deadline: number, body: (client: PoolClient) => Promise<T>): Promise<T> {
  requireAccessDeadline(deadline);
  return withConnection(pool, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL statement_timeout = '${Math.max(1, Math.floor(deadline - Date.now()))}ms'`);
      const value = await body(client);
      requireAccessDeadline(deadline);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(client, rollbackError as Error);
      }
      throw error;
    }
  });
}

async function lockRegistration(client: PoolClient, binding: Binding) {
  const owner = (
    await client.query<{ write_state: string }>(
      'SELECT write_state FROM core.partition WHERE partition_no=$1 FOR SHARE',
      [binding.registration.partition],
    )
  ).rows[0];
  if (!owner || owner.write_state !== 'active')
    throw new CommandUnavailableError('fenced', binding.registration.partition);
  const registration = (
    await client.query<{ consumer: string; state: string; coverage_generation: string }>(
      `SELECT consumer,state,coverage_generation::text FROM search.public_filter_registration
     WHERE (partition_no,id)=($1,$2) FOR UPDATE`,
      [binding.registration.partition, binding.registration.id],
    )
  ).rows[0];
  if (!registration || registration.state !== 'active' || registration.consumer !== binding.consumer)
    throw new CommandUnavailableError('contention', binding.registration.partition);
  return registration;
}

/** Pin the generation BEFORE taking any native home baseline. A later ACK can
 * never renew this preparation's generation or original immutable chain.
 */
export async function beginPublicFilterCoverageBaseline(pool: Pool, input: Binding, deadline: number) {
  const binding = snapshotBinding(input);
  return transaction(pool, deadline, async (client) => {
    const registration = await lockRegistration(client, binding);
    await client.query(
      `INSERT INTO search.public_filter_coverage_preparation
         (partition_no,registration,bootstrap,definition,consumer,generation,root,population_protocol)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1) ON CONFLICT DO NOTHING`,
      [
        binding.registration.partition,
        binding.registration.id,
        binding.bootstrap,
        binding.definition,
        binding.consumer,
        registration.coverage_generation,
        hash([binding.registration, binding.bootstrap, binding.definition, binding.consumer]),
      ],
    );
    const original = (
      await client.query<{ definition: string; consumer: string; generation: string }>(
        `SELECT definition::text,consumer,generation::text FROM search.public_filter_coverage_preparation
       WHERE (partition_no,registration,bootstrap)=($1,$2,$3)`,
        [binding.registration.partition, binding.registration.id, binding.bootstrap],
      )
    ).rows[0];
    if (!original || original.definition !== binding.definition || original.consumer !== binding.consumer)
      throw new CommandUnavailableError('contention', binding.registration.partition);
    // Source bootstrap and this registration currently share native home zero.
    // Keep the original cut, not a mutable preparation root after some receipts.
    if (binding.registration.partition !== 0)
      throw new CommandUnavailableError('contention', binding.registration.partition);
    const pinned = await client.query(
      `UPDATE semantic.public_filter_bootstrap SET coverage_generation=$2,
         coverage_root=coalesce(coverage_root,$3)
       WHERE partition_no=0 AND bootstrap=$1 AND state='capturing'
         AND (coverage_generation IS NULL OR coverage_generation=$2::bigint)
       RETURNING bootstrap`,
      [
        binding.bootstrap,
        original.generation,
        hash([binding.registration, binding.bootstrap, binding.definition, binding.consumer]),
      ],
    );
    if (pinned.rowCount !== 1) throw new CommandUnavailableError('contention', binding.registration.partition);
    return BigInt(original.generation);
  });
}

/** Adopt ONE committed original home receipt, after releasing that native home.
 * The indexed predecessor and its successor commit together in the registration
 * home. This is baseline enrollment, never a receiver-repair ACK.
 */
export async function adoptPublicFilterCoverageBaseline(
  pool: Pool,
  input: Binding,
  enrollment: AccountDiscoveryEnrollment,
  deadline: number,
): Promise<Readonly<{ after: number; root: string; generation: bigint }>> {
  // Capture before the first checkout. The owner proof and receiver adoption
  // must consume one tuple even if caller data changes across either await.
  const binding = snapshotBinding(input);
  const receipt = snapshotEnrollment(enrollment);
  if (
    !Number.isInteger(receipt.partition) ||
    receipt.partition < 0 ||
    receipt.partition > 4095 ||
    !receipt.complete ||
    receipt.receipt === null ||
    receipt.receipt !==
      hash([
        receipt.partition,
        binding.bootstrap,
        binding.registration.partition,
        binding.registration.id,
        binding.definition,
        receipt.epoch,
        String(receipt.sourcePosition),
        String(receipt.creationPosition),
        String(receipt.enqueueRevision),
        binding.accounts ? String(receipt.revision) : null,
        binding.accounts ? String(receipt.claimRevision) : null,
        receipt.keyDigest,
      ])
  )
    throw new CommandUnavailableError('contention', receipt.partition);
  // A digest identifies the receipt; it is not evidence that the owner committed
  // it. Resolve the exact immutable owner row before taking receiver custody.
  // No native-home connection is held while applying the receiver phase.
  await transaction(pool, deadline, async (client) => {
    const owner = (
      await client.query<{ epoch: number; write_state: string }>(
        'SELECT epoch,write_state FROM core.partition WHERE partition_no=$1 FOR SHARE',
        [receipt.partition],
      )
    ).rows[0];
    if (!owner || owner.write_state !== 'active' || owner.epoch !== receipt.epoch)
      throw new CommandUnavailableError('fenced', receipt.partition);
    const original = (
      await client.query<{ receipt: string }>(
        `SELECT receipt FROM semantic.public_filter_home_enrollment
       WHERE (partition_no,bootstrap)=($1,$2) AND complete
         AND registration_partition=$3 AND registration=$4 AND read_definition=$5
         AND owner_epoch=$6 AND source_position=$7 AND creation_position=$8
         AND native_enqueue_revision=$9 AND key_digest=$10 AND receipt=$11
         AND native_revision IS NOT DISTINCT FROM $12::bigint
         AND native_claim_revision IS NOT DISTINCT FROM $13::bigint
         AND creation_consumer=$14
         AND EXISTS (SELECT 1 FROM core.consumer_checkpoint c
           WHERE c.partition_no=$1 AND c.consumer=$14 AND c.position<=$8::bigint
             AND (c.epoch IS NULL OR c.epoch=$6)) FOR SHARE`,
        [
          receipt.partition,
          binding.bootstrap,
          binding.registration.partition,
          binding.registration.id,
          binding.definition,
          receipt.epoch,
          String(receipt.sourcePosition),
          String(receipt.creationPosition),
          String(receipt.enqueueRevision),
          receipt.keyDigest,
          receipt.receipt,
          binding.accounts ? String(receipt.revision) : null,
          binding.accounts ? String(receipt.claimRevision) : null,
          publicFilterCreationConsumer(binding.bootstrap),
        ],
      )
    ).rows[0];
    if (!original) throw new CommandUnavailableError('contention', receipt.partition);
  });
  return transaction(pool, deadline, async (client) => {
    await lockRegistration(client, binding);
    const preparation = (
      await client.query<{
        definition: string;
        consumer: string;
        generation: string;
        after_home: number;
        root: string;
      }>(
        `SELECT definition::text,consumer,generation::text,after_home,root
       FROM search.public_filter_coverage_preparation
       WHERE (partition_no,registration,bootstrap)=($1,$2,$3) FOR UPDATE`,
        [binding.registration.partition, binding.registration.id, binding.bootstrap],
      )
    ).rows[0];
    if (
      !preparation ||
      preparation.definition !== binding.definition ||
      preparation.consumer !== binding.consumer ||
      preparation.after_home < receipt.partition
    )
      throw new CommandUnavailableError('contention', binding.registration.partition);
    const keys = [binding.registration.partition, binding.registration.id, binding.bootstrap, receipt.partition];
    if (preparation.after_home > receipt.partition) {
      const replay = (
        await client.query<{ receipt: string; root: string }>(
          `SELECT receipt,root FROM search.public_filter_coverage_baseline
         WHERE (partition_no,registration,bootstrap,source_home)=($1,$2,$3,$4)`,
          keys,
        )
      ).rows[0];
      if (!replay || replay.receipt !== receipt.receipt)
        throw new CommandUnavailableError('contention', binding.registration.partition);
      return { after: receipt.partition + 1, root: replay.root, generation: BigInt(preparation.generation) };
    }
    const root = hash([preparation.root, receipt.partition, receipt.receipt]);
    await client.query(
      `INSERT INTO search.public_filter_coverage_baseline
        (partition_no,registration,bootstrap,source_home,source_epoch,source_position,creation_position,
         native_enqueue_revision,native_revision,native_claim_revision,receipt,predecessor,root)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        ...keys,
        receipt.epoch,
        String(receipt.sourcePosition),
        String(receipt.creationPosition),
        String(receipt.enqueueRevision),
        binding.accounts ? String(receipt.revision) : null,
        binding.accounts ? String(receipt.claimRevision) : null,
        receipt.receipt,
        preparation.root,
        root,
      ],
    );
    // Enrollment alone grants no repaired coverage, even for an empty home.
    // Keep the native domains distinct and leave the same summary behind until
    // genuine Source verification AND receiver settlement acknowledge it.
    const current = (
      await client.query<{ source_epoch: number }>(
        `SELECT source_epoch FROM search.public_filter_coverage_home
       WHERE (partition_no,registration,source_home)=($1,$2,$3) FOR UPDATE`,
        [binding.registration.partition, binding.registration.id, receipt.partition],
      )
    ).rows[0];
    if (current && current.source_epoch !== receipt.epoch) {
      const changed = (
        await client.query<{ generation: string }>(
          `UPDATE search.public_filter_registration SET coverage_generation=coverage_generation+1
         WHERE (partition_no,id)=($1,$2) RETURNING coverage_generation::text AS generation`,
          [binding.registration.partition, binding.registration.id],
        )
      ).rows[0]!;
      await client.query(
        `UPDATE search.public_filter_coverage_home SET source_epoch=$4,relevant_position=$5,
           native_enqueue_revision=$6,native_revision=$7,native_claim_revision=$8,
           acknowledged_position=0,acknowledged_native_enqueue=0,
           acknowledged_native_revision=NULL,acknowledged_native_claim_revision=NULL,
           baseline_bootstrap=$10,acknowledged_baseline=NULL,
           last_change_generation=$9,behind=true
         WHERE (partition_no,registration,source_home)=($1,$2,$3)`,
        [
          binding.registration.partition,
          binding.registration.id,
          receipt.partition,
          receipt.epoch,
          String(receipt.sourcePosition),
          String(receipt.enqueueRevision),
          binding.accounts ? String(receipt.revision) : null,
          binding.accounts ? String(receipt.claimRevision) : null,
          changed.generation,
          binding.bootstrap,
        ],
      );
    } else if (!current) {
      await client.query(
        `INSERT INTO search.public_filter_coverage_home
           (partition_no,registration,source_home,source_epoch,relevant_position,
            native_enqueue_revision,native_revision,native_claim_revision,last_change_generation,behind,
            baseline_bootstrap)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,true,$9)`,
        [
          binding.registration.partition,
          binding.registration.id,
          receipt.partition,
          receipt.epoch,
          String(receipt.sourcePosition),
          String(receipt.enqueueRevision),
          binding.accounts ? String(receipt.revision) : null,
          binding.accounts ? String(receipt.claimRevision) : null,
          binding.bootstrap,
        ],
      );
    } else {
      // A late baseline cannot inherit an earlier preparation's repaired state.
      // Preserve actual change generation and native positions; this receipt is
      // an enrollment obligation, not another Source change or a receiver ACK.
      await client.query(
        `UPDATE search.public_filter_coverage_home SET baseline_bootstrap=$4,behind=true
         WHERE (partition_no,registration,source_home)=($1,$2,$3)`,
        [binding.registration.partition, binding.registration.id, receipt.partition, binding.bootstrap],
      );
    }
    const advanced = await client.query(
      `UPDATE search.public_filter_coverage_preparation SET after_home=$4,root=$5
       WHERE (partition_no,registration,bootstrap)=($1,$2,$3) AND after_home=$6`,
      [
        binding.registration.partition,
        binding.registration.id,
        binding.bootstrap,
        receipt.partition + 1,
        root,
        receipt.partition,
      ],
    );
    if (advanced.rowCount !== 1) throw new CommandUnavailableError('contention', binding.registration.partition);
    return { after: receipt.partition + 1, root, generation: BigInt(preparation.generation) };
  });
}

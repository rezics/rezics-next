import { createHash } from 'node:crypto';
import { types } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import type { AccountDiscoveryEnrollment } from '../access/account-discovery-reduction.ts';
import { publicFilterCreationConsumer } from './public-filter-creation-consumer.ts';
import { maxPublicFilterEnrollmentHomes } from './public-filter-preparation-budget.ts';
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
      '/* semantic.native-keyed:1:1 */ SELECT write_state FROM core.partition WHERE partition_no=$1 FOR SHARE',
      [binding.registration.partition],
    )
  ).rows[0];
  if (!owner || owner.write_state !== 'active')
    throw new CommandUnavailableError('fenced', binding.registration.partition);
  const registration = (
    await client.query<{ consumer: string; state: string; coverage_generation: string }>(
      `/* semantic.native-keyed:1:1 */
       SELECT consumer,state,coverage_generation::text FROM search.public_filter_registration
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

type Adoption = Readonly<{ after: number; root: string; generation: bigint }>;

function requireReceipt(binding: Binding, receipt: AccountDiscoveryEnrollment) {
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
}

/** Confirm exact committed originals in one bounded read checkout. No Source
 * lock survives into the registration transaction.
 */
async function verifyReceipts(
  pool: Pool,
  binding: Binding,
  receipts: readonly AccountDiscoveryEnrollment[],
  deadline: number,
) {
  const originals = await transaction(pool, deadline, (client) =>
    client.query<{ partition: number; valid: boolean }>(
      `/* semantic.native-keyed:${3 * receipts.length}:${3 * receipts.length} */
       SELECT r.partition, e.receipt IS NOT NULL AS valid
       FROM jsonb_to_recordset($1::jsonb) AS r(partition integer, epoch integer,
         source_position bigint, creation_position bigint, enqueue_revision bigint,
         revision bigint, claim_revision bigint, key_digest text, receipt text)
       JOIN LATERAL (
         SELECT epoch FROM core.partition
         WHERE partition_no=r.partition AND write_state='active' AND epoch=r.epoch FOR SHARE
       ) p ON true
       LEFT JOIN LATERAL (
         SELECT e.receipt FROM semantic.public_filter_home_enrollment e
         WHERE (e.partition_no,e.bootstrap)=(r.partition,$2) AND e.complete
           AND (e.registration_partition,e.registration,e.read_definition)=($3,$4,$5)
           AND (e.owner_epoch,e.source_position,e.creation_position,e.native_enqueue_revision,e.key_digest,e.receipt)=
             (p.epoch,r.source_position,r.creation_position,r.enqueue_revision,r.key_digest,r.receipt)
           AND e.native_revision IS NOT DISTINCT FROM r.revision
           AND e.native_claim_revision IS NOT DISTINCT FROM r.claim_revision
           AND e.creation_consumer=$6
           AND EXISTS (SELECT 1 FROM core.consumer_checkpoint c
             WHERE (c.partition_no,c.consumer)=(r.partition,$6) AND c.position<=r.creation_position
               AND (c.epoch IS NULL OR c.epoch=p.epoch))
         FOR SHARE OF e
       ) e ON true
       ORDER BY r.partition`,
      [
        JSON.stringify(
          receipts.map((r) => ({
            partition: r.partition,
            epoch: r.epoch,
            source_position: String(r.sourcePosition),
            creation_position: String(r.creationPosition),
            enqueue_revision: String(r.enqueueRevision),
            revision: binding.accounts ? String(r.revision) : null,
            claim_revision: binding.accounts ? String(r.claimRevision) : null,
            key_digest: r.keyDigest,
            receipt: r.receipt,
          })),
        ),
        binding.bootstrap,
        binding.registration.partition,
        binding.registration.id,
        binding.definition,
        publicFilterCreationConsumer(binding.bootstrap),
      ],
    ),
  );
  // A hole must never permit advancement over that owner. Return any verified
  // prefix so an unavailable later home cannot strand earlier committed work.
  const length = receipts.findIndex(
    (r, i) => originals.rows[i]?.partition !== r.partition || !originals.rows[i]?.valid,
  );
  if (length === 0) {
    const first = receipts[0]!.partition;
    throw new CommandUnavailableError(originals.rows[0]?.partition === first ? 'contention' : 'fenced', first);
  }
  return length < 0 ? receipts : receipts.slice(0, length);
}

type Preparation = {
  definition: string;
  consumer: string;
  generation: string;
  after_home: number;
  root: string;
};

async function adoptReceipt(
  client: PoolClient,
  binding: Binding,
  preparation: Preparation,
  receipt: AccountDiscoveryEnrollment,
): Promise<Adoption> {
  if (preparation.after_home < receipt.partition)
    throw new CommandUnavailableError('contention', binding.registration.partition);
  const keys = [binding.registration.partition, binding.registration.id, binding.bootstrap, receipt.partition];
  if (preparation.after_home > receipt.partition) {
    const replay = (
      await client.query<{ receipt: string; root: string }>(
        `/* semantic.native-keyed:1:1 */
           SELECT receipt,root FROM search.public_filter_coverage_baseline
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
    `/* semantic.native-keyed:3:3 */
       INSERT INTO search.public_filter_coverage_baseline
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
      `/* semantic.native-keyed:1:1 */
         SELECT source_epoch FROM search.public_filter_coverage_home
       WHERE (partition_no,registration,source_home)=($1,$2,$3) FOR UPDATE`,
      [binding.registration.partition, binding.registration.id, receipt.partition],
    )
  ).rows[0];
  if (current && current.source_epoch !== receipt.epoch) {
    const changed = (
      await client.query<{ generation: string }>(
        `/* semantic.native-keyed:1:1 */
           UPDATE search.public_filter_registration SET coverage_generation=coverage_generation+1
         WHERE (partition_no,id)=($1,$2) RETURNING coverage_generation::text AS generation`,
        [binding.registration.partition, binding.registration.id],
      )
    ).rows[0]!;
    await client.query(
      `/* semantic.native-keyed:2:2 */
         UPDATE search.public_filter_coverage_home SET source_epoch=$4,relevant_position=$5,
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
      `/* semantic.native-keyed:3:3 */
         INSERT INTO search.public_filter_coverage_home
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
      `/* semantic.native-keyed:2:2 */
         UPDATE search.public_filter_coverage_home SET baseline_bootstrap=$4,behind=true
         WHERE (partition_no,registration,source_home)=($1,$2,$3)`,
      [binding.registration.partition, binding.registration.id, receipt.partition, binding.bootstrap],
    );
  }
  const advanced = await client.query(
    `/* semantic.native-keyed:2:2 */
       UPDATE search.public_filter_coverage_preparation SET after_home=$4,root=$5
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
  preparation.after_home = receipt.partition + 1;
  preparation.root = root;
  return { after: preparation.after_home, root, generation: BigInt(preparation.generation) };
}

/** Adopt a verified contiguous prefix with one registration lock. The caller
 * advances Source in this transaction, after each original receiver receipt,
 * so both existing per-home guards observe the same predecessor and root.
 */
export async function adoptPublicFilterCoverageBaselinePage(
  pool: Pool,
  input: Binding,
  enrollments: readonly AccountDiscoveryEnrollment[],
  deadline: number,
  advance: (client: PoolClient, adopted: Adoption, receipt: AccountDiscoveryEnrollment) => Promise<void>,
): Promise<void> {
  const binding = snapshotBinding(input);
  if (!Array.isArray(enrollments) || types.isProxy(enrollments) || enrollments.length > maxPublicFilterEnrollmentHomes)
    throw new TypeError('Baseline enrollment requires a bounded native page');
  const receipts = Array.from({ length: enrollments.length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(enrollments, index);
    if (!field || !Object.hasOwn(field, 'value')) throw new TypeError('Baseline page requires own data receipts');
    return snapshotEnrollment(field.value);
  });
  for (const [i, receipt] of receipts.entries()) {
    requireReceipt(binding, receipt);
    if (i > 0 && receipt.partition !== receipts[i - 1]!.partition + 1)
      throw new CommandUnavailableError('contention', receipt.partition);
  }
  if (receipts.length === 0) return;
  const verified = await verifyReceipts(pool, binding, receipts, deadline);
  await transaction(pool, deadline, async (client) => {
    await lockRegistration(client, binding);
    const preparation = (
      await client.query<Preparation>(
        `/* semantic.native-keyed:1:1 */
         SELECT definition::text,consumer,generation::text,after_home,root
         FROM search.public_filter_coverage_preparation
         WHERE (partition_no,registration,bootstrap)=($1,$2,$3) FOR UPDATE`,
        [binding.registration.partition, binding.registration.id, binding.bootstrap],
      )
    ).rows[0];
    if (!preparation || preparation.definition !== binding.definition || preparation.consumer !== binding.consumer)
      throw new CommandUnavailableError('contention', binding.registration.partition);
    for (const receipt of verified) {
      const adopted = await adoptReceipt(client, binding, preparation, receipt);
      await advance(client, adopted, receipt);
    }
  });
}

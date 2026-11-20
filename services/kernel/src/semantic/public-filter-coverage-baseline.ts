import { createHash } from 'node:crypto';
import { types } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import type { AccountDiscoveryEnrollment } from '../access/account-discovery-reduction.ts';
import type { PublicFilterConsumer } from './public-filter-source-contract.ts';
import type { NativePublicSource } from './public-filter-source-binding.ts';
import { publicFilterCreationConsumer } from './public-filter-creation-consumer.ts';
import { publicFilterCoverageKeys } from './public-filter-coverage-pending.ts';
import type { PublicFilterDependencyKey } from './public-filter-source-contract.ts';
import { maxPublicFilterEnrollmentHomes } from './public-filter-preparation-budget.ts';
import { AccessUnavailableError, CommandUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';
import { discardConnection, withBoundedCommandConnection, withConnection } from '../database/pool.ts';
import { bookPreparationTiming } from '../search/book-preparation-timing.ts';

export type PublicFilterBaselineBinding = Readonly<{
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

function snapshotBinding(input: PublicFilterBaselineBinding): PublicFilterBaselineBinding {
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

type BaselineTransaction = <T>(body: (client: PoolClient) => Promise<T>) => Promise<T>;

async function commitBaseline<T>(
  client: PoolClient,
  deadline: number,
  body: (client: PoolClient) => Promise<T>,
): Promise<T> {
  await client.query(`SET LOCAL statement_timeout = '${Math.max(1, Math.floor(deadline - Date.now()))}ms'`);
  const value = await body(client);
  requireAccessDeadline(deadline);
  await client.query('COMMIT');
  return value;
}

async function transaction<T>(pool: Pool, deadline: number, body: (client: PoolClient) => Promise<T>): Promise<T> {
  requireAccessDeadline(deadline);
  return withConnection(pool, async (client) => {
    await client.query('BEGIN');
    try {
      return await commitBaseline(client, deadline, body);
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

async function lockRegistration(client: PoolClient, binding: PublicFilterBaselineBinding) {
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
export async function beginPublicFilterCoverageBaseline(
  pool: Pool,
  input: PublicFilterBaselineBinding,
  deadline: number,
) {
  const binding = snapshotBinding(input);
  return transaction(pool, deadline, async (client) => {
    const registration = await lockRegistration(client, binding);
    await client.query(
      `INSERT INTO search.public_filter_coverage_preparation
         (partition_no,registration,bootstrap,definition,consumer,generation,root,population_protocol,ack_protocol)
       SELECT $1,$2,$3,$4,$5,$6,$7,1,coalesce(j.ack_protocol,0)
       FROM search.public_filter_registration r
       JOIN semantic.public_filter_bootstrap b ON (b.partition_no,b.bootstrap)=(r.partition_no,$3)
       JOIN search.public_filter_target t
         ON (t.partition_no,t.physical_target)=(r.partition_no,r.physical_target)
       LEFT JOIN search.generation_publication j
         ON (j.partition_no,j.physical_target,j.consumer)=(r.partition_no,r.physical_target,
            semantic.public_filter_native_json(r.consumer::jsonb))
         AND j.ack_protocol=1 AND j.family='subjects' AND j.source_home=0
         AND j.pass=1 AND j.fence IS NULL AND j.bootstrap IS NULL
         AND j.native_incarnation=t.incarnation AND j.binding->>'readDefinition'=b.read_definition::text
         AND b.snapshot_kind='prepared' AND b.state='capturing' AND b.coverage_generation IS NULL
         AND semantic.public_filter_native_json(b.consumer::jsonb)=j.consumer
       WHERE (r.partition_no,r.id)=($1,$2)
       ON CONFLICT DO NOTHING`,
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

function requireReceipt(binding: PublicFilterBaselineBinding, receipt: AccountDiscoveryEnrollment) {
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

/** Confirm exact committed originals in a separate transaction. No Source
 * lock survives into the registration transaction.
 */
async function verifyReceipts(
  transact: BaselineTransaction,
  binding: PublicFilterBaselineBinding,
  receipts: readonly AccountDiscoveryEnrollment[],
) {
  const originals = await transact((client) =>
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

/** Adopt a verified contiguous prefix with one registration lock and commit
 * both cursor advances with the original receipt chain and per-home effects.
 */
export async function adoptPublicFilterCoverageBaselinePage<T = void>(
  pool: Pool,
  input: PublicFilterBaselineBinding,
  enrollments: readonly AccountDiscoveryEnrollment[],
  deadline: number,
  readCommitted?: (client: PoolClient) => Promise<T>,
): Promise<T | undefined> {
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
  if (binding.registration.partition !== 0)
    throw new CommandUnavailableError('contention', binding.registration.partition);
  if (!readCommitted) {
    await adoptVerifiedPrefix((body) => transaction(pool, deadline, body), binding, receipts);
    return;
  }

  return withBoundedCommandConnection(
    pool,
    deadline,
    async (client) => {
      const transact: BaselineTransaction = async (body) => {
        requireAccessDeadline(deadline);
        await client.query('BEGIN');
        return commitBaseline(client, deadline, body);
      };
      const complete = await adoptVerifiedPrefix(transact, binding, receipts);
      if (complete) return readCommitted(client);
    },
    { deadlineError: () => new AccessUnavailableError('deadline') },
  );
}

async function adoptVerifiedPrefix(
  transact: BaselineTransaction,
  binding: PublicFilterBaselineBinding,
  receipts: readonly AccountDiscoveryEnrollment[],
) {
  const verified = await verifyReceipts(transact, binding, receipts);
  await transact(async (client) => {
    await lockRegistration(client, binding);
    await writeBaselinePage(client, binding, verified);
  });
  return verified.length === receipts.length;
}

async function writeBaselinePage(
  client: PoolClient,
  binding: PublicFilterBaselineBinding,
  receipts: readonly AccountDiscoveryEnrollment[],
) {
  // Keep the original input reservation, including the bounded interval
  // checks. Each home can write four rows, plus two cursor writes per page.
  await client.query(
    `/* semantic.native-keyed:${16 * receipts.length + 1}:${16 * receipts.length + 1}:${4 * receipts.length + 2} */
     SELECT semantic.adopt_public_filter_baseline_page($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      binding.registration.id,
      binding.bootstrap,
      binding.definition,
      binding.consumer,
      binding.accounts,
      JSON.stringify(
        receipts.map((receipt) => ({
          partition: receipt.partition,
          epoch: receipt.epoch,
          source_position: String(receipt.sourcePosition),
          creation_position: String(receipt.creationPosition),
          enqueue_revision: String(receipt.enqueueRevision),
          revision: String(receipt.revision),
          claim_revision: String(receipt.claimRevision),
          receipt: receipt.receipt,
        })),
      ),
    ],
  );
}

type HomeRange = Readonly<{ start: number; end: number }>;
export type PreparedEnrollmentRange = HomeRange & Readonly<{ digest: string }>;
export type ColdEnrollmentRequest = Readonly<{ version: 1; job: string; byteLimit: number }> &
  (
    | Readonly<{ action: 'prepare' | 'prepare-and-adopt'; ranges: readonly HomeRange[] }>
    | Readonly<{ action: 'adopt'; ranges: readonly PreparedEnrollmentRange[] }>
  );

const coldEnrollmentFixedInputs = 24;
const coldEnrollmentFixedBytes = 64 * 1024;
const coldEnrollmentAdoptInputsPerHome = 20;
const coldEnrollmentPrepareInputsPerHome = (keyCount: number) => 26 + 2 * keyCount;
const coldEnrollmentBytesPerHome = (keys: readonly string[]) => 12 * 1024 + 4 * Buffer.byteLength(JSON.stringify(keys));

/** Fund two disjoint prepares and their shared adoption from the same Search offer. */
export function planColdSubjectEnrollment(
  dependencies: readonly PublicFilterDependencyKey[],
  frontier: number,
  inputLimit: number,
  byteLimit: number,
): readonly HomeRange[] | null {
  const keys = publicFilterCoverageKeys(dependencies, true);
  if (keys.length > 450) return null;
  // One retained definition and bootstrap read, shared by preparation and adoption.
  const inputs = inputLimit - 2 * coldEnrollmentFixedInputs - 16;
  const bytes = byteLimit - 2 * coldEnrollmentFixedBytes - 64 * 1024;
  const homes = Math.min(
    4096 - frontier,
    maxPublicFilterEnrollmentHomes,
    Math.floor(inputs / (coldEnrollmentPrepareInputsPerHome(keys.length) + coldEnrollmentAdoptInputsPerHome)),
    Math.floor(bytes / (2 * coldEnrollmentBytesPerHome(keys))),
  );
  if (homes < 2) return null;
  const middle = frontier + Math.ceil(homes / 2);
  return [
    { start: frontier, end: middle },
    { start: middle, end: frontier + homes },
  ];
}

type ColdEnrollmentBinding = PublicFilterBaselineBinding &
  Readonly<{
    originalConsumer: PublicFilterConsumer;
    sourceConsumer: string;
    source: NativePublicSource;
    generation: string;
    job: string;
    keys: readonly string[];
  }>;

export function coldEnrollmentFunding(request: ColdEnrollmentRequest, keys: readonly string[]) {
  const { action, ranges } = request;
  if (
    request.version !== 1 ||
    typeof request.job !== 'string' ||
    !uuid.test(request.job) ||
    (action !== 'prepare' && action !== 'adopt' && action !== 'prepare-and-adopt') ||
    !Number.isSafeInteger(request.byteLimit) ||
    request.byteLimit < 0 ||
    request.byteLimit > 4 * 1024 * 1024 ||
    !Array.isArray(ranges) ||
    ranges.length < 1 ||
    ranges.length > 4 ||
    Array.from(ranges).some(
      ({ start, end }, i) =>
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        start >= end ||
        end > 4096 ||
        end - start > maxPublicFilterEnrollmentHomes ||
        (i > 0 && ranges[i - 1]!.end > start),
    ) ||
    (action === 'adopt' &&
      request.ranges.some(({ digest }) => typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)))
  )
    throw new TypeError('Invalid cold Subject enrollment range');
  const homes = ranges.reduce((sum, range) => sum + range.end - range.start, 0);
  if (homes > maxPublicFilterEnrollmentHomes || keys.length > 450)
    throw new RangeError('Cold enrollment exceeds its native page bound');
  // A failed group probe can repeat the Access reads on the retained path.
  // Reserve the original writes, the independent receipt reread, and both binding reads.
  const prepares = action !== 'adopt';
  const adopts = action !== 'prepare';
  const stages = prepares && adopts ? 2 : 1;
  const perHome =
    (prepares ? coldEnrollmentPrepareInputsPerHome(keys.length) : 0) + (adopts ? coldEnrollmentAdoptInputsPerHome : 0);
  return {
    inputs: stages * coldEnrollmentFixedInputs + homes * perHome,
    bytes: stages * (coldEnrollmentFixedBytes + homes * coldEnrollmentBytesPerHome(keys)),
  };
}

async function coldEnrollmentFrontier(client: Pool | PoolClient, binding: ColdEnrollmentBinding, locked = false) {
  const result = await client.query<{ after_home: number }>(
    `/* semantic.native-keyed:9:9 */
     SELECT c.after_home FROM search.public_filter_coverage_preparation c
     JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(c.partition_no,c.registration)
     JOIN search.public_filter_target t ON (t.partition_no,t.physical_target)=(r.partition_no,r.physical_target)
     JOIN search.generation_publication j ON (j.partition_no,j.job)=(c.partition_no,$7::uuid)
     JOIN semantic.public_filter_bootstrap b ON (b.partition_no,b.bootstrap)=(c.partition_no,c.bootstrap)
     JOIN core.partition p ON p.partition_no=b.partition_no
     WHERE (c.partition_no,c.registration,c.bootstrap)=(0,$1,$2::uuid)
       AND c.definition=$3::uuid AND c.consumer=$4 AND c.generation=$5::bigint AND c.population_protocol=1
       AND r.consumer=c.consumer AND r.consumer_bootstrap='0:'||b.bootstrap::text
       AND r.consumer_work IS NOT NULL AND r.state='active'
       AND j.family='subjects' AND j.pass=1 AND j.phase IN ('subject','engine','validate','reconciled')
       AND j.source_home=0 AND NOT j.fenced_pass AND j.fence IS NULL AND j.previous_uuid IS NULL
       AND j.bootstrap IS NULL AND j.physical_target=r.physical_target AND j.native_incarnation=t.incarnation
       AND j.physical_target=j.consumer->>'physicalTarget' AND j.native_incarnation=j.consumer->>'incarnation'
       AND j.consumer=$8::jsonb AND j.binding=$9::jsonb
       AND b.consumer=$10 AND b.read_definition=c.definition AND b.state IN ('capturing','begun') AND b.snapshot_kind='prepared'
       AND b.owner_epoch=$6 AND p.epoch=b.owner_epoch AND p.write_state='active'
       AND b.coverage_publication IS NULL AND b.queried IS NULL AND b.publication_job IS NULL
       AND b.account_after=c.after_home AND b.coverage_after=c.after_home AND b.coverage_root=c.root
       AND b.coverage_generation=c.generation
       AND NOT EXISTS (SELECT FROM search.public_filter_observation o
         WHERE (o.partition_no,o.registration)=(r.partition_no,r.id) AND o.state<>'closed')
       AND NOT EXISTS (SELECT FROM search.identity_writer_gate g
         WHERE (g.partition_no,g.physical_target)=(r.partition_no,r.physical_target)
           AND g.publication_fence IS NOT NULL)
     ${locked ? 'FOR SHARE OF j,c,b' : ''}`,
    [
      binding.registration.id,
      binding.bootstrap,
      binding.definition,
      binding.consumer,
      binding.generation,
      binding.source.epoch,
      binding.job,
      binding.originalConsumer,
      {
        source: binding.source,
        meaning: { digest: binding.originalConsumer.meaningDigest },
        readDefinition: binding.definition,
      },
      binding.sourceConsumer,
    ],
  );
  if (result.rowCount !== 1) throw new CommandUnavailableError('contention', 0);
  return result.rows[0]!.after_home;
}

async function readColdEnrollment(
  client: Pool | PoolClient,
  binding: ColdEnrollmentBinding,
  range: HomeRange,
  locked: boolean,
) {
  const { rows } = await client.query<{
    partition: number;
    epoch: number;
    source: string;
    creation: string;
    enqueue: string;
    revision: string;
    claim_revision: string;
    key_digest: string;
    receipt: string;
  }>(
    `/* semantic.native-keyed:${4 * (range.end - range.start)}:${4 * (range.end - range.start)} */
     SELECT h.home AS partition, p.epoch,e.source_position::text AS source,e.creation_position::text AS creation,
       e.native_enqueue_revision::text AS enqueue,e.key_digest,e.receipt,
       a.revision::text,a.claim_revision::text
     FROM generate_series($1::integer,$2::integer-1) h(home)
     JOIN LATERAL (SELECT epoch FROM core.partition WHERE partition_no=h.home AND write_state='active'
       LIMIT 1 ${locked ? 'FOR SHARE' : ''}) p ON true
     JOIN LATERAL (SELECT * FROM semantic.public_filter_home_enrollment
       WHERE (partition_no,bootstrap)=(h.home,$3::uuid)
         AND (registration_partition,registration,read_definition,owner_epoch)=(0,$4,$5::uuid,p.epoch)
         AND complete AND native_revision IS NULL AND receipt IS NOT NULL
         AND key_digest=$7 AND key_after IS NOT DISTINCT FROM $8 AND creation_consumer=$6
       LIMIT 1 ${locked ? 'FOR SHARE' : ''}) e ON true
     JOIN LATERAL (SELECT 1 FROM core.consumer_checkpoint
       WHERE (partition_no,consumer)=(h.home,$6) AND (epoch IS NULL OR epoch=p.epoch)
         AND position<=e.creation_position LIMIT 1 ${locked ? 'FOR SHARE' : ''}) pin ON true
     JOIN LATERAL (SELECT revision,claim_revision FROM access.account_discovery_population
       WHERE partition_no=h.home LIMIT 1) a ON true
     ORDER BY h.home`,
    [
      range.start,
      range.end,
      binding.bootstrap,
      binding.registration.id,
      binding.definition,
      publicFilterCreationConsumer(binding.bootstrap),
      hash(binding.keys),
      binding.keys.at(-1) ?? null,
    ],
  );
  if (rows.length !== range.end - range.start) throw new CommandUnavailableError('contention', range.start);
  const receipts = rows.map((row): AccountDiscoveryEnrollment => ({
    partition: row.partition,
    epoch: row.epoch,
    sourcePosition: BigInt(row.source),
    creationPosition: BigInt(row.creation),
    enqueueRevision: BigInt(row.enqueue),
    // The original Source cursor also retains the Access counters. Subject
    // receipts exclude them from the digest and receiver authority.
    revision: BigInt(row.revision),
    claimRevision: BigInt(row.claim_revision),
    keyDigest: row.key_digest,
    receipt: row.receipt,
    complete: true,
  }));
  for (const receipt of receipts) requireReceipt(binding, receipt);
  return receipts;
}

function coldEnrollmentDigest(
  binding: ColdEnrollmentBinding,
  range: HomeRange,
  receipts: readonly AccountDiscoveryEnrollment[],
) {
  return hash([
    1,
    binding.job,
    binding.bootstrap,
    binding.registration.id,
    binding.generation,
    binding.definition,
    binding.consumer,
    binding.source.epoch,
    range.start,
    range.end,
    receipts.map((receipt) => receipt.receipt),
  ]);
}

export async function prepareColdEnrollment(
  pool: Pool,
  binding: ColdEnrollmentBinding,
  ranges: readonly HomeRange[],
  enroll: (range: HomeRange) => Promise<void>,
) {
  const frontier = await coldEnrollmentFrontier(pool, binding);
  const results = await Promise.allSettled(
    ranges.map(async (range) => {
      const timing = range.start < 40 ? bookPreparationTiming : undefined;
      timing?.mark('enrollmentRangePrepareStart', range.start);
      try {
        // An already adopted range can be read back after a lost response.
        if (range.end > frontier) await enroll(range);
        const receipts = await readColdEnrollment(pool, binding, range, false);
        return { start: range.start, end: range.end, digest: coldEnrollmentDigest(binding, range, receipts) };
      } finally {
        timing?.mark('enrollmentRangePrepareEnd', range.start);
      }
    }),
  );
  // Drain all funded work before returning its shared accounting, even on failure.
  const prepared = results.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
  return { ranges: prepared, frontier: await coldEnrollmentFrontier(pool, binding) };
}

export async function adoptColdEnrollment(
  pool: Pool,
  binding: ColdEnrollmentBinding,
  ranges: readonly PreparedEnrollmentRange[],
  deadline: number,
  preparedFrontier?: number,
) {
  // A gap can be reported while its predecessor is still taking writer locks.
  const frontier = preparedFrontier ?? (await coldEnrollmentFrontier(pool, binding));
  const start = ranges[0]!.start;
  const end = ranges.at(-1)!.end;
  if (start > frontier || ranges.some((range, i) => i > 0 && range.start !== ranges[i - 1]!.end))
    return 'pending' as const;
  return transaction(pool, deadline, async (client) => {
    // Lock home zero before higher homes, and keep the original pins and owner
    // epochs stable through the ordered cursor write.
    await client.query('/* semantic.native-keyed:1:1 */ SELECT 1 FROM core.partition WHERE partition_no=0 FOR SHARE');
    const receipts = await readColdEnrollment(client, binding, { start, end }, true);
    for (const range of ranges) {
      const original = receipts.slice(range.start - start, range.end - start);
      if (coldEnrollmentDigest(binding, range, original) !== range.digest)
        throw new CommandUnavailableError('contention', range.start);
    }
    // Registration replaces the native target before taking its own row lock.
    const target = await client.query(
      `/* semantic.native-keyed:1:1 */ SELECT 1 FROM search.public_filter_target
       WHERE (partition_no,physical_target,incarnation)=(0,$1,$2) FOR SHARE`,
      [binding.originalConsumer.physicalTarget, binding.originalConsumer.incarnation],
    );
    if (target.rowCount !== 1) throw new CommandUnavailableError('contention', 0);
    await lockRegistration(client, binding);
    const current = await coldEnrollmentFrontier(client, binding, true);
    if (end <= current) return 'adopted' as const;
    if (start > current) return 'pending' as const;
    // An ordinary enrollment may have adopted part of this range in the meantime.
    await writeBaselinePage(client, binding, receipts.slice(current - start));
    return 'adopted' as const;
  });
}

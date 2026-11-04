import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool, PoolClient } from 'pg';
import { currentOperationalResources, enqueueIntent, type OperationalTransaction } from '../command/operational.ts';
import { withConnection } from '../database/pool.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { WorkClient, WorkIntent } from '../work/client.ts';
import type {
  HistoryExecutionPort,
  WorkExecutionOriginal,
} from '../command/execution-contract.ts';
import { assertWorkExecutionOriginal } from '../work/selected-runtime.ts';
import { receiveOperationalHistoryWork } from '../work/history-enqueue.ts';
import { guardHistoryAccounts } from './gates.ts';
import { encodeLocator, validateScope, type HistoryScope } from './locator.ts';
import { commandHistoryIdentityAccounts, unionHistoryScope } from './record.ts';
import {
  issueOperationalWorkTransfer,
  consumeOperationalWorkTransfer,
  finishOperationalWorkTransfers,
  OperationalWorkUnavailable,
  operationalWorkDeadlineClient,
  type OperationalWorkPhase,
  type OperationalWorkTransfer,
} from './operational-work-budget.ts';

export {
  OPERATIONAL_WORK_LOCAL_DECLARATION,
  OPERATIONAL_WORK_REGISTRATION,
  OPERATIONAL_WORK_RECEIVING,
  OPERATIONAL_WORK_TRANSFER_COST,
  type OperationalWorkTransfer,
} from './operational-work-budget.ts';
export const OPERATIONAL_WORK_OWNER = 'library.members-preparation';
export const OPERATIONAL_WORK_WORKFLOW = 'library.membersPreparation';
/** Dispatch hint only. Every use must independently resolve the durable native mapping. */
export const isOperationalWorkCustodyId = (id: string) => id.startsWith('6f70776b-');
export type OperationalEpisode = Readonly<{ collectionId: string; episodeId: string }>;
export type OperationalMembersBinding = Readonly<{
  route: number;
  ownerAccountId: string;
  collectionId: string;
  /** Exact NEW reservations; reuse with intent:null never enters this API. */
  episodes: readonly Readonly<
    OperationalEpisode & {
      reservedIncarnation: string;
      reservedGeneration: string;
      canonicalBasis: string;
      basisDigest: string;
    }
  >[];
  retired: readonly OperationalEpisode[];
}>;
declare const registration: unique symbol;
/** A serializable lookup key, NOT a receipt or evidence that COMMIT happened. */
export type OperationalWorkRegistration = Readonly<{
  partition: number;
  custodyId: string;
  readonly [registration]: true;
}>;
type Attempt = {
  original: WorkExecutionOriginal;
  pool: Pool;
  deadline: number;
  transactionId: string;
  registration?: {
    encoded: string;
    locator: OperationalWorkRegistration;
    intent: WorkIntent;
    fresh: boolean;
    enqueueStarted: boolean;
    created?: boolean;
    domain: OperationalWorkDomain;
  };
};
const attempts = new WeakMap<OperationalTransaction, Attempt>();
export function beginOperationalHistoryAttempt(tx: OperationalTransaction, original: WorkExecutionOriginal): void {
  const resources = currentOperationalResources(tx);
  if (attempts.has(tx)) throw new TypeError('Operational History attempt already open');
  assertWorkExecutionOriginal(tx, original);
  attempts.set(tx, {
    original,
    pool: resources.pool,
    deadline: resources.deadline,
    transactionId: randomUUID(),
  });
}
function attempt(tx: OperationalTransaction): Attempt {
  const resources = currentOperationalResources(tx);
  const state = attempts.get(tx);
  if (!state || state.pool !== resources.pool || state.deadline !== resources.deadline)
    throw new OperationalWorkUnavailable('operational-work-original-not-opted-in');
  return state;
}

/** A private one-shot child transfer. It activates ONLY after this actual executor's
 * successful COMMIT. Copies, failed attempts and escaped live handles cannot issue or spend it. */
export function reserveOperationalWorkTransfer(
  tx: OperationalTransaction,
  phase: OperationalWorkPhase,
): OperationalWorkTransfer {
  const state = attempt(tx);
  if (!Object.hasOwn({ resolve: 1, verify: 1, receive: 1, replay: 1, retirement: 1 }, phase))
    throw new TypeError('Unknown operational History phase');
  if (!state.registration) throw new OperationalWorkUnavailable('operational-work-native-registration-unavailable');
  return issueOperationalWorkTransfer(tx, state.original, phase, state.registration.locator.custodyId);
}

const episodeKey = (episode: OperationalEpisode) => JSON.stringify([episode.collectionId, episode.episodeId]);
const ordered = (episodes: readonly OperationalEpisode[]) =>
  episodes.every(
    (episode, index) =>
      index === 0 ||
      episode.collectionId > episodes[index - 1]!.collectionId ||
      (episode.collectionId === episodes[index - 1]!.collectionId &&
        episode.episodeId > episodes[index - 1]!.episodeId),
  );
function exactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
/** Pure shape/digest verification. It does not attest that a Commerce reservation exists. The
 * genuine Commerce writer supplies the native fields after its successful reserve SQL. */
export function validateOperationalMembersBinding(binding: OperationalMembersBinding, intent: WorkIntent): string {
  const invalid = () => {
    throw new TypeError('Invalid operational Members reservation binding');
  };
  if (
    !exactKeys(binding, ['route', 'ownerAccountId', 'collectionId', 'episodes', 'retired']) ||
    !Number.isInteger(binding.route) ||
    routeOf(binding.ownerAccountId) !== binding.route ||
    routeOf(binding.collectionId) !== binding.route ||
    !Array.isArray(binding.episodes) ||
    binding.episodes.length < 1 ||
    binding.episodes.length > 16 ||
    !Array.isArray(binding.retired) ||
    binding.retired.length > 32 ||
    !ordered(binding.episodes) ||
    !ordered(binding.retired)
  )
    invalid();
  const digestBasis = new Map<string, string>();
  for (const episode of binding.episodes) {
    if (
      !exactKeys(episode, [
        'collectionId',
        'episodeId',
        'reservedIncarnation',
        'reservedGeneration',
        'canonicalBasis',
        'basisDigest',
      ]) ||
      episode.collectionId !== binding.collectionId ||
      routeOf(episode.episodeId) !== binding.route ||
      typeof episode.reservedIncarnation !== 'string' ||
      episode.reservedIncarnation.length === 0 ||
      Buffer.byteLength(episode.reservedIncarnation) > 256 ||
      !/^(0|[1-9][0-9]{0,18})$/.test(episode.reservedGeneration) ||
      BigInt(episode.reservedGeneration) > 9223372036854775807n ||
      typeof episode.canonicalBasis !== 'string' ||
      !/^[0-9a-f]{64}$/.test(episode.basisDigest) ||
      createHash('sha256').update(episode.canonicalBasis).digest('hex') !== episode.basisDigest
    )
      invalid();
    let basis: unknown;
    try {
      basis = JSON.parse(episode.canonicalBasis);
    } catch {
      invalid();
    }
    if (
      !Array.isArray(basis) ||
      basis.length !== 6 ||
      basis[0] !== 1 ||
      basis[1] !== binding.ownerAccountId ||
      basis[2] !== binding.collectionId ||
      !['id', 'ordinal'].includes(basis[4]) ||
      typeof basis[5] !== 'string' ||
      canonicalize(basis) !== episode.canonicalBasis
    )
      invalid();
    if (digestBasis.has(episode.basisDigest)) invalid();
    digestBasis.set(episode.basisDigest, episode.canonicalBasis);
  }
  for (const episode of binding.retired)
    if (
      !exactKeys(episode, ['collectionId', 'episodeId']) ||
      routeOf(episode.collectionId) !== binding.route ||
      routeOf(episode.episodeId) !== binding.route ||
      binding.episodes.some((item) => episodeKey(item) === episodeKey(episode))
    )
      invalid();
  const input = {
    accounts: [binding.ownerAccountId],
    route: binding.route,
    episodes: binding.episodes.map(({ collectionId, episodeId }) => ({ collectionId, episodeId })),
    cleanup: binding.retired,
  };
  if (
    !exactKeys(intent, ['queue', 'workflowName', 'workflowId', 'input']) ||
    intent.queue !== 'workflows' ||
    intent.workflowName !== OPERATIONAL_WORK_WORKFLOW ||
    intent.workflowId !==
      `library:members-preparation:${binding.route}:${binding.ownerAccountId}:${binding.episodes[0]!.episodeId}` ||
    Buffer.byteLength(JSON.stringify(intent.input)) > 4096 ||
    canonicalize(intent.input) !== canonicalize(input)
  )
    invalid();
  const encoded = canonicalize({ binding, intent });
  if (!encoded || Buffer.byteLength(encoded) > 196608) invalid();
  return encoded!;
}

/** Internal enqueue hook: the existing enqueueIntent still owns the sole SDK call and SAME
 * underlying pg client. No identity mapping, CommandTransaction or alternate queue is involved. */
export function operationalHistoryEnqueueCapture(
  tx: OperationalTransaction,
  intent: WorkIntent,
): ((created: boolean) => void) | undefined {
  const state = attempts.get(tx);
  if (!state) return undefined;
  attempt(tx);
  const registration = state.registration;
  if (
    !registration ||
    !registration.fresh ||
    registration.enqueueStarted ||
    canonicalize(registration.intent) !== canonicalize(intent)
  )
    throw new TypeError('Operational History enqueue lacks its exact new reservation');
  registration.enqueueStarted = true;
  return (created) => {
    registration.created = created;
  };
}

function identityScope(tx: OperationalTransaction, owner: string): HistoryScope {
  // This is the actual Access-installed role union (principal/actor/acting-human/delegate/
  // operator/etc.), not role inference from the locator-only SDK payload.
  const identity = commandHistoryIdentityAccounts(tx);
  if (identity.length === 0)
    throw new OperationalWorkUnavailable('operational-work-original-identity-evidence-unavailable');
  const scope = unionHistoryScope('durable-work/v1', identity, [
    { accountId: owner, accountRoute: routeOf(owner)!, roles: 8192 | 64 },
  ]);
  validateScope('durable-work/v1', scope);
  if (scope.accounts.length > 8) throw new TypeError('Operational identity role union exceeds eight accounts');
  return scope;
}

export const OPERATIONAL_WORK_DOMAIN = 'operational-work/v1';
export type OperationalWorkDomain = typeof OPERATIONAL_WORK_DOMAIN | 'legacy-unpositioned';
/** Distinct from the canonical event Stamp. Positions compare ONLY within this domain/partition.
 * Decimal strings preserve the entire positive PostgreSQL bigint range across JSON/SDK ports. */
export type OperationalWorkStamp = Readonly<{
  domain: typeof OPERATIONAL_WORK_DOMAIN;
  partition: number;
  epoch: number;
  generation: string;
  position: string;
}>;
/** Versioned opt-in ORIGINAL serializer. Call immediately after the native reservation SQL;
 * this replaces that call site's sole enqueueIntent. The locator is not a committed receipt. */
export function registerPositionedOperationalHistoryWork(
  tx: OperationalTransaction,
  binding: OperationalMembersBinding,
  intent: WorkIntent,
): Promise<OperationalWorkRegistration> {
  return registerOriginal(tx, binding, intent, OPERATIONAL_WORK_DOMAIN);
}
/** Retained unpositioned interface. Its originals stay explicitly legacy; neither reuse nor a
 * later call through the positioned interface backfills them or captures an old SDK execution. */
export function registerOperationalHistoryWork(
  tx: OperationalTransaction,
  binding: OperationalMembersBinding,
  intent: WorkIntent,
): Promise<OperationalWorkRegistration> {
  return registerOriginal(tx, binding, intent, 'legacy-unpositioned');
}
async function registerOriginal(
  tx: OperationalTransaction,
  input: OperationalMembersBinding,
  workIntent: WorkIntent,
  originDomain: OperationalWorkDomain,
): Promise<OperationalWorkRegistration> {
  const state = attempt(tx);
  const resources = currentOperationalResources(tx);
  const binding = structuredClone(input);
  const intent = structuredClone(workIntent);
  const encoded = validateOperationalMembersBinding(binding, intent);
  if (
    resources.mode !== 'request' ||
    resources.kind !== OPERATIONAL_WORK_WORKFLOW ||
    resources.partition !== partitionOf(binding.route) ||
    resources.accounts.length !== 1 ||
    resources.accounts[0] !== binding.ownerAccountId
  )
    throw new TypeError('Operational Members original differs from its reservation');
  if (state.registration) {
    if (state.registration.encoded !== encoded || state.registration.domain !== originDomain)
      throw new TypeError('Conflicting operational History registration');
    return state.registration.locator;
  }
  const scope = identityScope(tx, binding.ownerAccountId);
  const digest = createHash('sha256').update(canonicalize({ binding, intent, scope })!).digest();
  const stored = (
    await tx.query(
      `SELECT custody_id,request_digest,operation_kind,operation_mode,operation_accounts FROM core.operational_work_original
     WHERE partition_no=$1 AND workflow_id=$2 FOR SHARE`,
      [resources.partition, intent.workflowId],
    )
  ).rows[0];
  if (stored) {
    if (
      !Buffer.from(stored.request_digest).equals(digest) ||
      stored.operation_kind !== resources.kind ||
      stored.operation_mode !== resources.mode ||
      canonicalize(stored.operation_accounts) !== canonicalize(resources.accounts)
    )
      throw new TypeError('Conflicting operational History registration');
    const locator = Object.freeze({
      partition: resources.partition,
      custodyId: stored.custody_id,
    }) as OperationalWorkRegistration;
    state.registration = { encoded, locator, intent, fresh: false, enqueueStarted: false, domain: originDomain };
    return locator;
  }
  const domain = (await tx.query('SELECT generation::text FROM core.history_family_domain WHERE singleton FOR SHARE'))
    .rows[0];
  if (!domain) throw new OperationalWorkUnavailable('operational-work-source-domain-unavailable');
  const locator = Object.freeze({
    partition: resources.partition,
    custodyId: `6f70776b${randomUUID().slice(8)}`,
  }) as OperationalWorkRegistration;
  state.registration = { encoded, locator, intent, fresh: true, enqueueStarted: false, domain: originDomain };
  const stamp =
    originDomain === OPERATIONAL_WORK_DOMAIN
      ? await allocateOperationalPosition(
          tx,
          resources.partition,
          locator.custodyId,
          state.transactionId,
          intent.workflowId,
          digest,
          resources.deadline,
          domain.generation,
        )
      : null;
  await guardHistoryAccounts(tx, resources.partition, scope.accounts);
  // Match the receiving SDK's domain-before-writer order, on this SAME original client.
  const sdkDomain = (
    await tx.query('SELECT restore_generation::text FROM dbos.workflow_writer_fence_domain WHERE singleton FOR SHARE')
  ).rows[0];
  if (!sdkDomain) throw new OperationalWorkUnavailable('operational-work-sdk-restore-domain-unavailable');
  let retained = false;
  // Probe ALL original physical families before admission. An uncaptured older execution is
  // retained as an obligation; it never becomes positively captured through an SDK dedup hit.
  for (const [table, key] of OPERATIONAL_SDK_TABLES)
    retained =
      (await tx.query(`SELECT 1 FROM dbos.${table} WHERE ${key}=$1 LIMIT 1`, [intent.workflowId])).rows.length > 0 ||
      retained;
  // Keep an uncovered older SDK projection bounded BEFORE its upsert/readback callback.
  const projection = (
    await tx.query(
      `SELECT (SELECT octet_length(jsonb_build_array(status,name,class_name,config_name,queue_name,
       executor_id,creator_xid,serialization)::text)<=4096 FROM dbos.workflow_status WHERE workflow_uuid=$1) AS status_ok,
       (SELECT octet_length(inputs)<=8192 FROM dbos.workflow_input WHERE workflow_uuid=$1) AS input_ok`,
      [intent.workflowId],
    )
  ).rows[0];
  if (projection.status_ok === false || projection.input_ok === false)
    throw new OperationalWorkUnavailable('operational-work-existing-sdk-projection-budget-uncovered');
  await enqueueIntent(tx, intent);
  if (state.registration.created === undefined)
    throw new OperationalWorkUnavailable('operational-work-sdk-creation-seam-unavailable');
  const writer = (
    await tx.query(
      `SELECT f.generation::text,f.closure_id,f.closed_at,d.restore_generation::text,s.creator_xid,
       CASE WHEN octet_length(i.inputs)<=8192 THEN i.inputs END AS inputs
     FROM dbos.workflow_writer_fences f CROSS JOIN dbos.workflow_writer_fence_domain d
     JOIN dbos.workflow_status s ON s.workflow_uuid=$1
     JOIN dbos.workflow_input i ON i.workflow_uuid=s.workflow_uuid
     WHERE f.workflow_uuid=$1 AND d.singleton FOR SHARE OF f,d,s,i`,
      [intent.workflowId],
    )
  ).rows[0];
  if (
    !writer ||
    writer.generation !== '1' ||
    writer.closure_id !== null ||
    writer.restore_generation !== sdkDomain.restore_generation ||
    typeof writer.inputs !== 'string'
  )
    throw new OperationalWorkUnavailable('operational-work-sdk-writer-unavailable');
  const writerState = {
    workflowID: intent.workflowId,
    generation: writer.generation,
    restoreGeneration: writer.restore_generation,
    closureID: null,
    closedAt: null,
  };
  await tx.query(
    `INSERT INTO core.operational_work_original(partition_no,custody_id,transaction_id,workflow_id,request_digest,
       binding,intent,scope,operation_kind,operation_mode,operation_accounts,deadline,source_generation,creation_captured,sdk_writer,sdk_creator,sdk_input_digest,source_domain,source_position,log_gap)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [
      resources.partition,
      locator.custodyId,
      state.transactionId,
      intent.workflowId,
      digest,
      binding,
      intent,
      scope,
      resources.kind,
      resources.mode,
      JSON.stringify(resources.accounts),
      resources.deadline,
      domain.generation,
      state.registration.created && !retained,
      writerState,
      writer.creator_xid,
      createHash('sha256').update(writer.inputs).digest(),
      originDomain,
      stamp?.position ?? null,
      stamp ? null : 'operational-work-original-log-position-unavailable',
    ],
  );
  await tx.query(
    `INSERT INTO core.operational_work_episode(partition_no,route,owner_account_id,collection_id,episode_id,custody_id)
     SELECT $1,$2,$3,e."collectionId",e."episodeId",$4
     FROM jsonb_to_recordset($5::jsonb) e("collectionId" uuid,"episodeId" uuid)`,
    [resources.partition, binding.route, binding.ownerAccountId, locator.custodyId, JSON.stringify(binding.episodes)],
  );
  await insertOperationalWorkInventory(
    tx,
    resources.partition,
    locator.custodyId,
    digest,
    scope,
    intent,
    resources.partition,
    null,
  );
  return locator;
}

/** Native exact inventory, shared by the source serializer and committed destination receiver.
 * Source identity is read from the native original, never supplied by its caller. */
export async function insertOperationalWorkInventory(
  tx: Pick<PoolClient, 'query'>,
  partition: number,
  custodyId: string,
  digest: Uint8Array,
  scope: HistoryScope,
  intent: WorkIntent,
  sourcePartition: number,
  sourceTransaction: string | null,
): Promise<void> {
  await tx.query(
    `INSERT INTO core.history_work(partition_no,work_id,request_digest,owner,request,scope,source_partition,source_transaction,admitted)
     VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8::uuid,(SELECT transaction_id FROM core.operational_work_original
       WHERE partition_no=$7 AND custody_id=$2)),true) ON CONFLICT(partition_no,work_id) DO NOTHING`,
    [
      partition,
      custodyId,
      Buffer.from(digest),
      OPERATIONAL_WORK_OWNER,
      intent,
      scope,
      sourcePartition,
      sourceTransaction,
    ],
  );
  const locator = Buffer.from(encodeLocator({ artifactType: 'durable-work/v1', workId: custodyId }));
  for (const account of scope.accounts)
    await tx.query(
      `INSERT INTO core.history_locator(partition_no,account_route,account_id,artifact_type,locator,roles,minimizer_version)
       VALUES($1,$2,$3,'durable-work/v1',$4,$5,1) ON CONFLICT DO NOTHING`,
      [partition, account.accountRoute, account.accountId, locator, account.roles],
    );
}

/** Lock order within this domain: executor partition/Account fences, family domain, permanent
 * operational head, ordered History seals, SDK restore/writer. No other home's client is held.
 * The UPSERT row lock, counter and bound original all survive or roll back in the SAME commit. */
async function allocateOperationalPosition(
  tx: OperationalTransaction,
  partition: number,
  custodyId: string,
  transactionId: string,
  workflowId: string,
  digest: Uint8Array,
  deadline: number,
  generation: string,
): Promise<OperationalWorkStamp> {
  const row = (
    await tx.query(
      `INSERT INTO core.operational_work_head AS h(partition_no,epoch,generation,position,
       custody_id,transaction_id,workflow_id,request_digest,deadline)
     SELECT p.partition_no,p.epoch,$2,1,$3,$4,$5,$6,$7 FROM core.partition p
     WHERE p.partition_no=$1 AND p.write_state='active'
     ON CONFLICT(partition_no) DO UPDATE SET epoch=EXCLUDED.epoch,generation=EXCLUDED.generation,
       position=h.position+1,custody_id=EXCLUDED.custody_id,transaction_id=EXCLUDED.transaction_id,
       workflow_id=EXCLUDED.workflow_id,request_digest=EXCLUDED.request_digest,deadline=EXCLUDED.deadline
     RETURNING epoch,generation::text,position::text`,
      [partition, generation, custodyId, transactionId, workflowId, Buffer.from(digest), deadline],
    )
  ).rows[0];
  if (!row) throw new OperationalWorkUnavailable('operational-work-native-position-unavailable');
  return Object.freeze({
    domain: OPERATIONAL_WORK_DOMAIN,
    partition,
    epoch: row.epoch,
    generation: row.generation,
    position: row.position,
  });
}

/** Seal before the executor's actual COMMIT. The deferred native constraint verifies the
 * positioned binding against the locked head and actual partition/family fences. */
export async function finalizeOperationalHistoryAttempt(tx: OperationalTransaction): Promise<void> {
  const state = attempts.get(tx);
  if (!state?.registration?.fresh) return;
  const resources = currentOperationalResources(tx);
  const result = await tx.query(
    `UPDATE core.operational_work_original o SET source_epoch=p.epoch,sealed=true
     FROM core.partition p WHERE p.partition_no=$1 AND p.write_state='active'
       AND o.partition_no=$1 AND o.custody_id=$2 AND NOT o.sealed
     RETURNING o.custody_id`,
    [resources.partition, state.registration.locator.custodyId],
  );
  if (result.rows.length !== 1)
    throw new OperationalWorkUnavailable('operational-work-native-commit-fence-unavailable');
}
export function finishOperationalHistoryAttempt(tx: OperationalTransaction, committed: boolean): void {
  finishOperationalWorkTransfers(tx, committed);
  attempts.delete(tx);
}

export const OPERATIONAL_SDK_TABLES = [
  ['workflow_status', 'workflow_uuid'],
  ['workflow_input', 'workflow_uuid'],
  ['workflow_output', 'workflow_uuid'],
  ['operation_outputs', 'workflow_uuid'],
  ['workflow_events', 'workflow_uuid'],
  ['workflow_events_history', 'workflow_uuid'],
  ['notifications', 'destination_uuid'],
  ['streams', 'workflow_uuid'],
] as const;
type OperationalWorkSourceBody = Readonly<{
  partition: number;
  custodyId: string;
  transactionId: string;
  epoch: number;
  generation: string;
  workflowId: string;
  digest: string;
  binding: OperationalMembersBinding;
  intent: WorkIntent;
  scope: HistoryScope;
  sdkWriter: import('../work/sdk-retirement-fence.ts').SdkWriterState;
  sdkCreator: string | null;
  sdkInputDigest: string;
  creationCaptured: boolean;
  deadline: number;
}>;
export type OperationalWorkSource = OperationalWorkSourceBody &
  (
    | Readonly<{ position: null; gap: 'operational-work-original-log-position-unavailable'; stamp?: never }>
    | Readonly<{
        position: string;
        gap: 'operational-work-source-currentness-unavailable';
        stamp: OperationalWorkStamp;
      }>
  );
declare const committedOrigin: unique symbol;
export type CommittedOperationalWork = { readonly [committedOrigin]: true };
const committed = new WeakMap<
  CommittedOperationalWork,
  { pool: Pool; source: OperationalWorkSource; deadline: number }
>();
export function operationalWorkSource(pool: Pool, origin: CommittedOperationalWork): OperationalWorkSource {
  const bound = committed.get(origin);
  if (!bound || bound.pool !== pool || Date.now() >= bound.deadline)
    throw new TypeError('Missing or expired committed operational History original');
  return structuredClone(bound.source);
}
const positiveBigint = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;

/** Held, full-key native verification. No SDK or foreign home is acquired here. The current
 * head bounds an immutable original; it is NEVER substituted for that original's position. */
async function readHeldOperationalOriginal(
  tx: Pick<PoolClient, 'query'>,
  locator: Pick<OperationalWorkRegistration, 'partition' | 'custodyId'>,
): Promise<OperationalWorkSource | null> {
  const home = (
    await tx.query('SELECT epoch,write_state FROM core.partition WHERE partition_no=$1 FOR SHARE', [locator.partition])
  ).rows[0];
  const domain = (await tx.query('SELECT generation::text FROM core.history_family_domain WHERE singleton FOR SHARE'))
    .rows[0];
  const head = (
    await tx.query(
      'SELECT epoch,generation::text,position::text FROM core.operational_work_head WHERE partition_no=$1 FOR SHARE',
      [locator.partition],
    )
  ).rows[0];
  const row = (
    await tx.query('SELECT * FROM core.operational_work_original WHERE partition_no=$1 AND custody_id=$2 FOR SHARE', [
      locator.partition,
      locator.custodyId,
    ])
  ).rows[0];
  if (!row || !row.sealed) return null;
  if (
    !home ||
    home.write_state !== 'active' ||
    home.epoch !== row.source_epoch ||
    domain?.generation !== row.source_generation
  )
    throw new OperationalWorkUnavailable('operational-work-source-restore-fence-changed');
  const positioned = row.source_domain === OPERATIONAL_WORK_DOMAIN;
  if (
    positioned &&
    (!positiveBigint(row.source_position) ||
      !head ||
      head.epoch !== row.source_epoch ||
      head.generation !== row.source_generation ||
      !positiveBigint(head.position) ||
      BigInt(row.source_position) > BigInt(head.position) ||
      row.log_gap !== null)
  )
    throw new OperationalWorkUnavailable('operational-work-native-position-fence-changed');
  if (
    !positioned &&
    (row.source_domain !== 'legacy-unpositioned' ||
      row.source_position !== null ||
      row.log_gap !== 'operational-work-original-log-position-unavailable')
  )
    throw new OperationalWorkUnavailable('operational-work-native-position-domain-invalid');
  validateOperationalMembersBinding(row.binding, row.intent);
  validateScope('durable-work/v1', row.scope);
  if (
    row.operation_kind !== OPERATIONAL_WORK_WORKFLOW ||
    row.operation_mode !== 'request' ||
    canonicalize(row.operation_accounts) !== canonicalize([row.binding.ownerAccountId]) ||
    row.partition_no !== partitionOf(row.binding.route) ||
    row.workflow_id !== row.intent.workflowId ||
    row.sdk_writer.workflowID !== row.workflow_id
  )
    throw new OperationalWorkUnavailable('operational-work-native-original-binding-changed');
  const digest = createHash('sha256')
    .update(canonicalize({ binding: row.binding, intent: row.intent, scope: row.scope })!)
    .digest();
  if (!Buffer.from(row.request_digest).equals(digest)) throw new TypeError('Operational original digest mismatch');
  const body: OperationalWorkSourceBody = {
    partition: row.partition_no,
    custodyId: row.custody_id,
    transactionId: row.transaction_id,
    epoch: row.source_epoch,
    generation: row.source_generation,
    workflowId: row.workflow_id,
    digest: digest.toString('hex'),
    binding: row.binding,
    intent: row.intent,
    scope: row.scope,
    sdkWriter: row.sdk_writer,
    sdkCreator: row.sdk_creator,
    sdkInputDigest: Buffer.from(row.sdk_input_digest).toString('hex'),
    creationCaptured: row.creation_captured,
    deadline: Number(row.deadline),
  };
  if (!positioned) return { ...body, position: null, gap: 'operational-work-original-log-position-unavailable' };
  return {
    ...body,
    position: row.source_position,
    gap: 'operational-work-source-currentness-unavailable',
    stamp: {
      domain: OPERATIONAL_WORK_DOMAIN,
      partition: row.partition_no,
      epoch: row.source_epoch,
      generation: row.source_generation,
      position: row.source_position,
    },
  };
}

async function commitOperationalRead(tx: Pick<PoolClient, 'query'>, deadline: number): Promise<void> {
  await tx.query("SELECT set_config('statement_timeout',$1,true)", [String(Math.max(1, deadline - Date.now()))]);
  await tx.query('COMMIT');
}

/** A one-shot same-home recheck. All native source fences stay held through this
 * commit; the result is LOCAL provenance only, not a Source-currentness or replay capability.
 * Call after releasing any receiving client, never inside a cross-home callback. */
export async function verifyCommittedOperationalWorkOrigin(
  pool: Pool,
  origin: CommittedOperationalWork,
  transfer: OperationalWorkTransfer,
): Promise<OperationalWorkStamp> {
  const source = operationalWorkSource(pool, origin);
  const { deadline: transferDeadline } = consumeOperationalWorkTransfer(pool, transfer, 'verify', source.custodyId);
  const deadline = Math.min(transferDeadline, source.deadline);
  return withConnection(pool, async (client) => {
    const tx = operationalWorkDeadlineClient(client, deadline);
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      await tx.query("SELECT set_config('statement_timeout',$1,true)", [String(Math.max(1, deadline - Date.now()))]);
      const current = await readHeldOperationalOriginal(tx, source);
      if (!current || canonicalize(current) !== canonicalize(source))
        throw new OperationalWorkUnavailable('operational-work-native-original-changed');
      if (!current.stamp) throw new OperationalWorkUnavailable(current.gap);
      await commitOperationalRead(tx, deadline);
      return current.stamp;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}
/** One full-key committed-state resolution. Precommit/rolled-back locators return null. This
 * function requires a released, successful original transfer before any Pool checkout. */
export async function resolveCommittedOperationalWork(
  pool: Pool,
  locator: OperationalWorkRegistration,
  transfer: OperationalWorkTransfer,
): Promise<CommittedOperationalWork | null> {
  const { deadline } = consumeOperationalWorkTransfer(pool, transfer, 'resolve', locator.custodyId);
  if (
    !Number.isInteger(locator.partition) ||
    locator.partition < 0 ||
    locator.partition > 4095 ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(locator.custodyId)
  )
    throw new TypeError('Invalid operational History locator');
  const source = await withConnection(pool, async (client) => {
    const tx = operationalWorkDeadlineClient(client, deadline);
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      await tx.query("SELECT set_config('statement_timeout',$1,true)", [String(Math.max(1, deadline - Date.now()))]);
      const value = await readHeldOperationalOriginal(tx, locator);
      if (Date.now() >= deadline) throw new OperationalWorkUnavailable('operational-work-deadline');
      await commitOperationalRead(tx, deadline);
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  if (!source) return null;
  const origin = Object.freeze({}) as CommittedOperationalWork;
  if (Date.now() >= source.deadline) throw new OperationalWorkUnavailable('operational-work-deadline');
  committed.set(origin, { pool, source, deadline: Math.min(deadline, source.deadline) });
  return origin;
}

/** Release the source client before entering the independently fenced destination home. */
export async function receiveCommittedOperationalWork(
  pool: Pool,
  client: WorkClient,
  origin: CommittedOperationalWork,
  transfer: OperationalWorkTransfer,
): Promise<'registered-pending-source-currentness' | 'registered-pending-position' | 'uncaptured'> {
  return receiveOperationalHistoryWork(pool, client, origin, transfer);
}

/** History-owned persistence adapter selected by the Kernel composition roots. */
export const historyExecutionPort: HistoryExecutionPort = Object.freeze({
  begin: beginOperationalHistoryAttempt,
  finalize: finalizeOperationalHistoryAttempt,
  finish: finishOperationalHistoryAttempt,
  enqueueCapture: operationalHistoryEnqueueCapture,
});

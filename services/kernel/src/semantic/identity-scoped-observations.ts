import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { WorkContext } from '../work/registry.ts';
import {
  currentCommand,
  noEffect,
  currentCommandResources,
  registerCommandCallback,
  runCommand,
  withSingleCommandAttempt,
  type CommandTransaction,
} from '../command/command.ts';
import {
  createNativeLibrarySourceCustody,
  type NativeSourceIdentity,
  type NativeLibrarySourceCustody,
  type NativeSourceFrontier,
} from '../library/native-source-custody.ts';
import { NativeCollectionWork, instrumentNativeCollectionWork } from '../library/collection-source-work.ts';
import { libraryIdentityFootprint } from '../library/identity-native-planner-work.ts';
import {
  readLibraryScopeEffectsPage,
  verifyLibraryScopeEffectsSeal,
  type LibraryScopeEffectSeal,
  type LibraryExpectedEffectAfter,
  type LibraryScopeEffectsKey,
} from '../library/identity-scope-effects.ts';
import type { WorkAllowance, WorkDimensions, WorkReceipt } from '../library/collection-source.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import type * as S from './identity-scope-types.ts';
import type { PublicIdentityOutputCapture } from './identity-public-output-types.ts';
import {
  lockPublicIdentityOutputCaptureCurrent,
  readPublicIdentityOutputCaptureCurrent,
} from './identity-public-output-capture.ts';
import type { IdentityNativeReceipt } from './identity-epoch-contract.ts';
import { bindSemanticProducerRoles } from './erasure-producer.ts';
import type { IdentityPrearmTicketData } from './identity-epoch-prearm-contract.ts';
import type { IdentityReceivingRecord, IdentityReceivingSelection } from './identity-receiving-effects-types.ts';
import {
  IdentityEpochStoreError,
  identityJobPartition,
  recordIdentityEpochNativeCommit,
  serializeIdentityValue as json,
} from './identity-epoch-store.ts';
import {
  publicIdentityCaptureLocator,
  verifyPublicIdentitySourceCaptureLocator,
} from './identity-scoped-public-source.ts';
import { withReadTransaction } from './read.ts';
import { writeIdentityScopeConsumerNativeCommit } from './identity-epoch-native-commit.ts';
import {
  prepayIdentityScopeNativeAssociation,
  bindIdentityScopeNativeAssociation,
  recordIdentityScopeNativeAssociation,
} from './identity-scope-native-association.ts';
import receivingSelectionRead from './identity-receiving-selection-read.sql';
import receivingLookup from './identity-epoch-store-receiving-lookup.sql';
import receivingPlan from './identity-epoch-store-receiving-plan.sql';
import consumerCurrent from './identity-scoped-consumer-current.sql';
import consumerReceipt from './identity-scoped-consumer-receipt.sql';
import consumerWork from './identity-scoped-consumer-work.sql';
import consumerConflict from './identity-scoped-consumer-conflict.sql';
import consumerInsert from './identity-scoped-consumer-insert.sql';
import consumerNative from './identity-scoped-consumer-native.sql';
import insertNativeCommit from './identity-epoch-store-insert-native-commit.sql';
import commandTime from '../command/time.sql';
import commandNoEffect from '../command/no-effect-fence.sql';
import partitionRead from '../partition/read.sql';
import { classifyUnavailability } from '../access/unavailable.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import {
  identitySourceConsumerLibraryWork,
  currentIdentitySourceConsumerMaintenance,
  currentIdentitySourceConsumerLibraryRemainder,
  isPrepaidIdentitySourceConsumerMaintenance,
  claimIdentitySourceScheduledCall,
  claimIdentitySourceLibraryCall,
  withIdentitySourceNoEffectCommand,
  reserveIdentitySourceConsumerNativeWork,
  isLiveIdentitySourceConsumerMaintenance,
  IdentitySourceOriginalUnavailable,
} from './identity-source-consumer-maintenance.ts';
import type {
  IdentitySourceConsumerContext,
  IdentitySourceScopeConsumerWork,
} from './identity-source-consumer-custody.ts';

/** Resolve the retained registration/capture using the existing Source frame.
 * The historical capture allowance is never consulted as a remaining balance.
 */
export async function readIdentityScopeConsumerWork(
  pool: Pool,
  ticket: IdentityPrearmTicketData,
  context: IdentitySourceConsumerContext,
): Promise<IdentitySourceScopeConsumerWork | null> {
  const budget = identitySourceConsumerLibraryWork(pool, context.identityConsumerWork, context.deadline);
  if (!budget) return null;
  ticket = structuredClone(ticket);
  const source = ticket.scope.source;
  if (source.kind !== 'library' || source.identity.scope === 'public_output') return null;
  const values = scopeConsumerValues(ticket);
  const prepaid = isPrepaidIdentitySourceConsumerMaintenance(pool);
  claimIdentitySourceScheduledCall(pool, 'scopeAdmission');
  return withRequestDeadline(context.deadline, async () => {
    try {
      const current = prepaid ? (await withIdentitySourceNoEffectCommand(pool, context.deadline, () =>
        runCommand(pool, { partition: identityScopeAddress(ticket.scope).partition, deadline: context.deadline }, async (tx) => {
          const cost = scopeConsumerFootprint(consumerWork.sql, values);
          if (!context.identityConsumerWork || !cost ||
              !reserveIdentitySourceConsumerNativeWork(pool, context.identityConsumerWork, {
                rows: cost.nativeRows, points: cost.nativePoints, statements: cost.statements,
                bytes: cost.bytes, engineRequests: 0,
              }, cost)) throw new IdentitySourceOriginalUnavailable('identity-source-scope-admission-literal-unavailable');
          const row = (await tx.query<{ source_generation: string }>(consumerWork.sql, values)).rows[0];
          if (!isLiveIdentitySourceConsumerMaintenance(pool, context.identityConsumerWork, context.deadline))
            throw new IdentitySourceOriginalUnavailable('identity-source-scope-admission-ended');
          return noEffect(row);
        }),
      )).value : await instrumentNativeCollectionWork(pool, budget, scopeConsumerFootprint, () =>
        withReadTransaction(
          pool,
          async (tx) => (await tx.query<{ source_generation: string }>(consumerWork.sql, values)).rows[0],
        ),
      );
      if (!current || current.source_generation !== source.identity.generation) return null;
      // This immutable ceiling describes the same ledger. The consumer binds it once
      // across page transfer, receiving, both verifications and the durable fence.
      const remaining: WorkDimensions = Object.freeze({
        candidateKeys: budget.available('candidateKeys'),
        identityMetadataRows: budget.available('identityMetadataRows'),
        nativeRows: budget.available('nativeRows'),
        nativePoints: budget.available('nativePoints'),
        witnessKeys: budget.available('witnessKeys'),
        statements: budget.available('statements'),
        bytes: budget.available('bytes'),
        emptySeeks: budget.available('emptySeeks'),
      });
      return Object.freeze({
        allowance: Object.freeze({ reservationId: budget.receipt().reservationId, remaining }),
        footprint: (sql: string, values: readonly unknown[]) =>
          libraryIdentityFootprint(sql, values, budget) ?? scopeConsumerFootprint(sql, values),
      });
    } catch (error) {
      // The instrumenter charges dispatched failures and poisons its SAME ledger.
      if (budget.failure || classifyUnavailability(error)) return null;
      throw error;
    }
  });
}

function scopeConsumerValues(ticket: IdentityPrearmTicketData): unknown[] {
  if (ticket.scope.source.kind !== 'library') throw new TypeError('Native Library scope required');
  return [
    ...params(ticket.scope),
    ticket.registration,
    ticket.captureId,
    ticket.locator.job.jobId,
    ticket.locator.job.epoch.toString(),
    json(ticket.attempt),
    json(ticket.scope.source),
    ticket.scope.source.identity.ownerEpoch,
    ticket.locator.directory.transactionId,
    ticket.locator.pageId,
    ticket.locator.ordinal,
  ];
}

/** Only exact original owner statements have known accounting. In particular,
 * Library seal and receiving SQL need their owners' actual footprints; unfamiliar
 * SQL remains undefined and is refused by NativeCollectionWork before dispatch.
 * Each native projection below is fixed or schema-bounded (seal <=4096 bytes).
 */
export function scopeConsumerFootprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined {
  // Exact positional operands are part of the proof. Reject extra, unbounded or
  // structurally different parameters before a connection can dispatch this SQL.
  const text = (max: number) => (v: unknown) => typeof v === 'string' && Buffer.byteLength(v) <= max;
  const positive = (v: unknown) => typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
  const integer = (max: number, min = 0) => (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
  const id = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
  const hash = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
  const document = (max: number) => (v: unknown) => {
    if (!text(max)(v)) return false;
    try { const parsed: unknown = JSON.parse(v as string); return !!parsed && typeof parsed === 'object'; } catch { return false; }
  };
  const home = integer(4095);
  const epoch = integer(2147483647, 1);
  const scope = (v: unknown) => text(256)(v) && (v as string).length > 0;
  let operands: readonly ((v: unknown) => boolean)[];
  let rows: number;
  let outputBytes: number;
  let statements = 1;
  let emptySeeks = 1;
  if (sql === consumerCurrent.sql || sql === consumerWork.sql) {
    operands = [home, hash, scope, id, id, id, positive, document(1024), document(4096), epoch, id, id, integer(2147483647)];
    rows = 7;
    // Both projections return only these two bigint strings, the <=256-byte
    // generation and <=4096-byte native JSON seal. Six bytes per generation byte
    // covers JSON escaping; no arbitrary capture or maintenance allowance leaves.
    outputBytes = Buffer.byteLength(JSON.stringify([{ revision: '9'.repeat(19), version: '9'.repeat(19),
      source_generation: 'f'.repeat(256), seal: null }])) + 5 * 256 + 4096;
  } else if (sql === receivingSelectionRead.sql) {
    operands = [home, id, positive, scope, id, id];
    rows = 2; // One unique receiving record and its exact native commit.
    outputBytes = 128;
  } else if (sql === receivingLookup.sql) {
    operands = [home, id, positive, scope, id, id, epoch, positive];
    // Record, original commit, current partition, gate, effect, effect commit,
    // and its exact step. The original writer bounds binding to 4096 and
    // frontier to 2048; fixed receipt locators and scalar fields fit the rest.
    rows = 7;
    outputBytes = 8192;
  } else if (sql === receivingPlan.sql) {
    operands = [home, id, positive, scope];
    rows = 3;
    outputBytes = 6144;
  } else if (
    sql ===
    `SELECT pending_job,pending_epoch FROM semantic.identity_epoch_receiving_gate
    WHERE partition_no=$1 AND owner_id=$2 AND original=$3 AND owner_epoch=$4 FOR UPDATE`
  ) {
    operands = [home, id, id, epoch];
    rows = 1;
    outputBytes = 128;
  } else if (
    sql ===
    `SELECT native_partition,native_epoch,native_position,native_transaction_id
      FROM semantic.identity_epoch_effect_receipt WHERE partition_no=$1 AND job_id=$2 AND step=$3 AND effect_key=$4 FOR UPDATE`
  ) {
    operands = [home, id, (v) => v === 'library-private-follow-counts', scope];
    rows = 1;
    outputBytes = 128;
  } else if (
    sql ===
    `SELECT c.transaction_id,c.epoch,c.position FROM semantic.identity_epoch_native_commit c
        JOIN semantic.identity_epoch_receiving_custody a ON (a.partition_no,a.transaction_id)=(c.partition_no,c.transaction_id)
        WHERE a.partition_no=$1 AND a.job_id=$2 AND a.effect_key=$3 AND c.purpose='identity-receiving-custody' AND c.xmin=a.xmin`
  ) {
    operands = [home, id, scope];
    rows = 2;
    outputBytes = 128;
  } else if (sql === consumerReceipt.sql) {
    operands = [home, hash, scope, id, id, positive, hash, id];
    rows = 3;
    outputBytes = 2048;
  } else if (sql === consumerConflict.sql || sql === consumerNative.sql || sql === partitionRead.sql || sql === commandNoEffect.sql) {
    operands = sql === consumerConflict.sql ? [home, hash, scope, id, id, positive]
      : sql === consumerNative.sql ? [home, id]
      : sql === partitionRead.sql ? [home]
      : [home, id, (v) => v === null]; // A receipt write is a different native command.
    rows = 1;
    outputBytes = 1024;
  } else if (sql === commandTime.sql) {
    operands = [text(128)];
    rows = 0;
    emptySeeks = 0;
    outputBytes = 128;
  } else if (sql === insertNativeCommit.sql) {
    operands = [home, id, (v) => v === 'identity-scope-finish'];
    rows = 2;
    emptySeeks = 0;
    outputBytes = 128;
  } else if (sql === consumerInsert.sql) {
    operands = [home, hash, scope, id, id, id, positive, document(1024), scope, positive, hash, epoch, positive, id];
    // One insert, two FK points and seven exact-key rows in the deferred native
    // fence constraint. None of these charges depends on returned row counts.
    rows = 1 + 2 + 7;
    statements = 1 + 2 + 1; // INSERT, two FK checks, deferred seven-key query.
    emptySeeks = 1; // The deferred EXISTS can refuse even an inserted row.
    outputBytes = 0;
  } else if (
    sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' ||
    sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE' ||
    sql === 'COMMIT' ||
    sql === 'ROLLBACK' ||
    sql === "SET LOCAL lock_timeout = '200ms'" ||
    /^SET LOCAL statement_timeout = '[1-9][0-9]{0,3}ms'$/.test(sql)
  ) {
    operands = [];
    rows = 0;
    emptySeeks = 0;
    outputBytes = 0;
  } else {
    return undefined;
  }
  if (values.length !== operands.length || operands.some((accept, i) => !accept(values[i]))) return undefined;
  return Object.freeze({
    // These exact bodies enumerate no candidates, read no Semantic basis metadata,
    // and expand no listing witnesses. Native indexed joins are charged below.
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: rows,
    nativePoints: rows,
    witnessKeys: 0,
    statements,
    bytes: Buffer.byteLength(sql) + Buffer.byteLength(json(values)) + outputBytes,
    emptySeeks,
  });
}

type Work = { -readonly [K in keyof S.IdentityScopeWork]: S.IdentityScopeWork[K] };
const work = (): Work => ({ rows: 0, points: 0, statements: 0, bytes: 0 });
const fail = (
  reason: S.IdentityScopeFailure['reason'],
  measured: Work,
  status: 'unavailable' | 'stale' = 'unavailable',
): S.IdentityScopeFailure => ({ status, reason, work: measured });
const digest = (v: object) =>
  createHash('sha256')
    .update(canonicalize(JSON.parse(json(v)))!)
    .digest('hex');
const same = (a: object, b: object) => digest(a) === digest(b);
const unavailable = () =>
  new IdentityEpochStoreError('identity_epoch_unavailable', 'Native scoped Source custody is unavailable');
const HOME = '00000000-0000-0000-0000-000000000000';
type Head = {
  partition_no: number;
  source_key: string;
  scope_id: string;
  source: S.IdentityScopeSource;
  registration: string;
  capture_id: string;
  capture:
    | S.IdentityScopeCapture
    | PublicLocator
    | { kind: 'public-output-locator'; capture: PublicIdentityOutputCapture };
  state: 'capturing' | 'enrolling' | 'ready' | 'repair' | 'retiring' | 'retired';
  revision: string;
  active: number;
  frontier: NativeSourceFrontier | null;
  scan_complete: boolean;
  enrollment_home: number;
  maintenance_allowance: WorkAllowance | null;
};

function isReadyScopeState(state: Head['state']): boolean {
  return state === 'ready';
}
type PublicLocator = NonNullable<ReturnType<typeof publicIdentityCaptureLocator>> & { kind: 'public-locator' };
type Dependency = {
  dependency: string;
  original: string | null;
  dependency_home: number | null;
  sending_known: boolean;
  directory_home: number | null;
  directory_generation: string | null;
  directory_group: string | null;
};

/** Incarnation identifies the Source; per-effect receiving hints never create a second Source registry. */
export function identityScopeAddress(key: S.IdentityScopeKey): { partition: number; source: string; scope: string } {
  if (
    !key ||
    typeof key.scopeId !== 'string' ||
    Buffer.byteLength(key.scopeId) < 1 ||
    Buffer.byteLength(key.scopeId) > 256
  )
    throw new TypeError('Scoped observations require a bounded native scope ID');
  const source = key.source;
  if (source.kind === 'library') {
    const i = source.identity;
    if (
      routeOf(i.collectionId) !== i.route ||
      !i.incarnation ||
      !Number.isSafeInteger(i.ownerEpoch) ||
      i.ownerEpoch < 1 ||
      (i.scope !== 'public_output' && routeOf(i.accountId) === null) ||
      (i.scope === 'public_output' &&
        (!i.outputGeneration ||
          !i.activation.transactionId ||
          !/^(0|[1-9][0-9]*)$/.test(i.activation.position) ||
          !i.activation.sourceGeneration))
    )
      throw new TypeError('Invalid native Library Source identity');
    const binding =
      i.scope === 'public_output'
        ? { outputGeneration: i.outputGeneration, activation: i.activation }
        : { accountId: i.accountId };
    // CURRENT generation can change. The activation locator and resource incarnation cannot.
    return {
      partition: partitionOf(i.route),
      source: digest({
        kind: source.kind,
        route: i.route,
        collectionId: i.collectionId,
        incarnation: i.incarnation,
        scope: i.scope,
        ...binding,
      }),
      scope: key.scopeId,
    };
  }
  const i = source.identity;
  if (
    !i.id ||
    !i.configuration ||
    !Number.isInteger(i.partition) ||
    i.partition < 0 ||
    i.partition > 4095 ||
    !Number.isInteger(i.epoch) ||
    i.epoch < 1
  )
    throw new TypeError('Invalid native public Source identity');
  return {
    partition: i.partition,
    source: digest({ kind: source.kind, id: i.id, configuration: i.configuration }),
    scope: key.scopeId,
  };
}
function params(key: S.IdentityScopeKey): [number, string, string] {
  const k = identityScopeAddress(key);
  return [k.partition, k.source, k.scope];
}
async function query(tx: CommandTransaction, measured: Work, sql: string, values: unknown[] = []) {
  const result = await tx.query(sql, values);
  measured.statements++;
  measured.rows += result.rowCount ?? 0;
  measured.points += result.rowCount ?? 0;
  measured.bytes += Buffer.byteLength(json(result.rows));
  return result;
}
async function head(
  tx: CommandTransaction,
  key: S.IdentityScopeKey,
  measured: Work,
  lock = false,
): Promise<Head | null> {
  return (
    (
      await query(
        tx,
        measured,
        `SELECT s.* FROM semantic.identity_scope_summary s JOIN core.partition p ON p.partition_no=s.partition_no AND p.write_state='active' AND p.moved_to IS NULL AND p.epoch=$4 WHERE s.partition_no=$1 AND source_key=$2 AND scope_id=$3
        AND NOT EXISTS(SELECT 1 FROM semantic.identity_scope_consumer_fence f
        WHERE (f.partition_no,f.source_key,f.scope_id)=(s.partition_no,s.source_key,s.scope_id))${lock ? ' FOR UPDATE OF s' : ''}`,
        [...params(key), key.source.kind === 'library' ? key.source.identity.ownerEpoch : key.source.identity.epoch],
      )
    ).rows[0] ?? null
  );
}
function observation(key: S.IdentityScopeKey, row: Head): S.IdentityScopeObservation {
  return { key, captureId: row.capture_id, committedRevision: BigInt(row.revision) };
}
function charge(measured: Work, receipt: WorkReceipt) {
  measured.rows += receipt.used.nativeRows + receipt.used.identityMetadataRows;
  measured.points += receipt.used.nativePoints;
  measured.statements += receipt.used.statements;
  measured.bytes += receipt.used.bytes;
}
async function ownerCurrent(tx: CommandTransaction, key: S.IdentityScopeKey): Promise<boolean> {
  const a = identityScopeAddress(key);
  const native = await readPartition(tx, a.partition);
  const expected = key.source.kind === 'library' ? key.source.identity.ownerEpoch : key.source.identity.epoch;
  return !!native && native.writeState === 'active' && native.movedTo === null && native.epoch === expected;
}
async function proofCurrent(
  tx: CommandTransaction,
  key: S.IdentityScopeKey,
  row: Head,
  measured: Work,
  retained = false,
  budget?: NativeCollectionWork,
): Promise<boolean> {
  if (!same(key.source, row.source) || !(await ownerCurrent(tx, key))) return false;
  if (row.capture.kind === 'public-locator') return verifyPublicIdentitySourceCaptureLocator(tx, row.capture);
  if (row.capture.kind === 'public-output-locator') {
    if (!budget) return false;
    const capture = row.capture.capture;
    const result = await budget.compose((allowance) =>
      lockPublicIdentityOutputCaptureCurrent(
        tx,
        capture,
        {
          pool: currentCommandResources(tx).pool,
          at: currentCommand(tx).time,
          deadline: currentCommandResources(tx).deadline,
          allowance,
        },
        retained,
      ),
    );
    charge(measured, result.work);
    measured.outputWork = result.work;
    return result.status === (retained ? 'retained' : 'current') && same(result.key, key);
  }
  if (
    key.source.kind !== 'library' ||
    row.capture.kind !== 'library' ||
    !row.scan_complete ||
    row.frontier?.driver !== 'done'
  )
    return false;
  const owner = nativeCustody(currentCommandResources(tx));
  const identity = key.source.identity;
  const read = (allowance: WorkAllowance) =>
    (retained ? owner.revalidateHold : owner.readAndHold)({
      client: tx,
      at: currentCommand(tx).time,
      identity,
      captureId: row.capture_id,
      holdId: row.registration,
      allowance,
      deadline: currentCommandResources(tx).deadline,
    });
  const held = await (budget ? budget.compose(read) : read(row.capture.allowance));
  charge(measured, held.work);
  return held.status === 'held';
}

/** Native directory ticket, independently reread after its producer command has released. */
async function enroll(
  pool: Pool,
  key: S.IdentityScopeKey,
  row: Head,
  dep: Dependency,
  deadline: number,
  measured: Work,
): Promise<object | null> {
  if (!dep.sending_known) return null; // Pre-upgrade uncertain sends have no safe invented home.
  let home = dep.directory_home ?? dep.dependency_home;
  let group = dep.directory_group ?? HOME;
  let generation = dep.directory_generation ?? HOME;
  if (dep.original && dep.directory_home === null) {
    const original = dep.original;
    const mapping = await withReadTransaction(
      pool,
      async (tx) =>
        (
          await query(
            tx,
            measured,
            `SELECT control_partition,control_group,owner_epoch
      FROM semantic.identity_epoch_mapping WHERE route=$1 AND original=$2`,
            [routeOf(original), original],
          )
        ).rows[0],
    );
    if (!mapping || mapping.control_partition === null || mapping.control_group === null) return null;
    home = mapping.control_partition;
    group = mapping.control_group;
    const current = await withReadTransaction(
      pool,
      async (tx) =>
        (
          await query(
            tx,
            measured,
            `SELECT generation FROM semantic.identity_epoch_group
      WHERE partition_no=$1 AND terminal=$2 AND ready AND pending_job IS NULL`,
            [home, group],
          )
        ).rows[0],
    );
    if (!current) return null;
    generation = current.generation;
  }
  if (home === null) return null;
  const k = identityScopeAddress(key);
  if (dep.directory_home === null) {
    const retained = await runCommand(pool, { partition: k.partition, deadline }, async (tx) => {
      const locked = await head(tx, key, measured, true);
      if (
        !locked ||
        locked.registration !== row.registration ||
        locked.capture_id !== row.capture_id ||
        locked.state === 'retiring' ||
        locked.state === 'retired'
      )
        return { value: false, events: [] };
      const result = await query(
        tx,
        measured,
        `UPDATE semantic.identity_scope_forward
        SET directory_home=$6,directory_generation=$7,directory_group=$8
        WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND registration=$4 AND dependency=$5
          AND (directory_home IS NULL OR (directory_home,directory_generation,directory_group)=($6,$7,$8))`,
        [...params(key), row.registration, dep.dependency, home, generation, group],
      );
      return { value: result.rowCount === 1, events: [] };
    });
    if (!retained.value) return null;
  }
  const issued = await runCommand(pool, { partition: home, deadline }, async (tx) => {
    if (dep.original) {
      const g = (
        await query(
          tx,
          measured,
          `SELECT generation,version,owner_epoch,ready,pending_job FROM semantic.identity_epoch_group
        WHERE partition_no=$1 AND terminal=$2 FOR UPDATE`,
          [home, group],
        )
      ).rows[0];
      const native = await readPartition(tx, home!);
      if (
        !g ||
        !native ||
        g.generation !== generation ||
        !g.ready ||
        g.pending_job !== null ||
        g.owner_epoch !== native.epoch
      )
        return { value: false, events: [] };
      const member = await query(
        tx,
        measured,
        `SELECT 1 FROM semantic.identity_epoch_original WHERE partition_no=$1 AND generation=$2 AND original=$3 AND present AND terminal=$4`,
        [home, g.generation, dep.original, group],
      );
      if (member.rowCount !== 1) return { value: false, events: [] };
      // Register in the delivered admission producer's indexed directory. PREPARE closes
      // this same bridge before its first export, so a late registration cannot become ready.
      await query(
        tx,
        measured,
        `INSERT INTO semantic.identity_epoch_prearm_bridge
        (partition_no,generation,terminal,owner_epoch,basis_version) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT DO NOTHING`,
        [home, generation, group, g.owner_epoch, g.version],
      );
      const nativeBridge = (
        await query(
          tx,
          measured,
          `SELECT terminal,owner_epoch,basis_version,job_id
        FROM semantic.identity_epoch_prearm_bridge WHERE partition_no=$1 AND generation=$2 FOR UPDATE`,
          [home, generation],
        )
      ).rows[0];
      if (
        !nativeBridge ||
        nativeBridge.job_id !== null ||
        nativeBridge.terminal !== group ||
        nativeBridge.owner_epoch !== g.owner_epoch ||
        nativeBridge.basis_version !== g.version
      )
        return { value: false, events: [] };
    }
    await query(
      tx,
      measured,
      `INSERT INTO semantic.identity_scope_bridge(partition_no,generation) VALUES($1,$2) ON CONFLICT DO NOTHING`,
      [home, generation],
    );
    const bridge = (
      await query(
        tx,
        measured,
        `SELECT closed_job FROM semantic.identity_scope_bridge WHERE partition_no=$1 AND generation=$2 FOR UPDATE`,
        [home, generation],
      )
    ).rows[0];
    if (!bridge || bridge.closed_job !== null) return { value: false, events: [] };
    const released = await query(
      tx,
      measured,
      `SELECT 1 FROM semantic.identity_scope_directory_release
      WHERE partition_no=$1 AND generation=$2 AND original=$3 AND source_partition=$4 AND source_key=$5 AND scope_id=$6 AND registration=$7 AND capture_id=$8`,
      [home, generation, dep.original ?? HOME, k.partition, k.source, k.scope, row.registration, row.capture_id],
    );
    if (released.rowCount) return { value: false, events: [] };
    if (!dep.original) {
      // A claim that predates the creation guard cannot be hidden by registering afterward.
      // Claims change this same bridge row, so a stale SERIALIZABLE snapshot must retry.
      const pending = await query(
        tx,
        measured,
        `SELECT 1 FROM semantic.identity_epoch_group
        WHERE partition_no=$1 AND pending_job IS NOT NULL ORDER BY terminal LIMIT 1`,
        [home],
      );
      if (pending.rowCount) return { value: false, events: [] };
      const fenced = await query(
        tx,
        measured,
        `SELECT 1 FROM semantic.identity_public_capture_home h
        JOIN semantic.identity_public_writer w ON w.partition_no=h.partition_no AND w.revision=h.writer_revision
        JOIN core.partition p ON p.partition_no=h.partition_no AND p.epoch=h.owner_epoch
        WHERE h.partition_no=$1 AND h.capture_id=$2 AND h.home=$1 AND h.complete
        AND p.write_state='active' AND p.moved_to IS NULL FOR SHARE OF h,w`,
        [home, row.capture_id],
      );
      if (fenced.rowCount !== 1) return { value: false, events: [] };
    }
    await query(
      tx,
      measured,
      `INSERT INTO semantic.identity_scope_inverse
      (partition_no,generation,original,source_partition,source_key,scope_id,registration,capture_id,source,transaction_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [
        home,
        generation,
        dep.original ?? HOME,
        k.partition,
        k.source,
        k.scope,
        row.registration,
        row.capture_id,
        json(key.source),
        currentCommand(tx).transactionId,
      ],
    );
    if (dep.original) {
      const identity = key.source.identity;
      bindSemanticProducerRoles(
        tx,
        key.source.kind === 'library' && 'accountId' in identity
          ? [{ account_id: identity.accountId, role: 'subject' }]
          : [],
      );
    }
    recordIdentityEpochNativeCommit(tx, 'identity-scope-enrollment');
    if (dep.original)
      registerCommandCallback(tx, async (transactionId) => {
        // The native receipt must exist before the admission inverse's same-home FK is written.
        await query(
          tx,
          measured,
          `INSERT INTO semantic.identity_epoch_prearm_inverse
        (partition_no,generation,original,scope_key,registration,scope,capture_id,
         source_partition,source_owner_epoch,transaction_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
          [
            home,
            generation,
            dep.original,
            digest({ source: k.source, scope: k.scope }),
            row.registration,
            json(key),
            row.capture_id,
            k.partition,
            key.source.kind === 'library' ? key.source.identity.ownerEpoch : key.source.identity.epoch,
            transactionId,
          ],
        );
      });
    return { value: true, events: [] };
  });
  if (!issued.value) return null;
  return withReadTransaction(
    pool,
    async (tx) =>
      (
        await query(
          tx,
          measured,
          `SELECT i.partition_no,i.generation,i.original,i.registration,i.capture_id,i.transaction_id,c.epoch,c.position::text
    FROM semantic.identity_scope_inverse i JOIN semantic.identity_epoch_native_commit c
    ON (c.partition_no,c.transaction_id)=(i.partition_no,i.transaction_id) AND c.xmin=i.xmin
    JOIN core.partition p ON p.partition_no=i.partition_no AND p.epoch=c.epoch AND p.position>=c.position
    WHERE i.partition_no=$1 AND i.generation=$2 AND i.original=$3 AND i.source_partition=$4 AND i.source_key=$5
      AND i.scope_id=$6 AND i.registration=$7 AND i.capture_id=$8 AND c.purpose='identity-scope-enrollment'
      AND p.write_state='active' AND p.moved_to IS NULL
      AND ($3::uuid='00000000-0000-0000-0000-000000000000' OR EXISTS(
        SELECT 1 FROM semantic.identity_epoch_prearm_inverse n
        JOIN semantic.identity_epoch_native_commit nc ON nc.partition_no=n.partition_no
          AND nc.transaction_id=n.transaction_id AND nc.xmin=n.xmin AND nc.purpose='identity-scope-enrollment'
        WHERE n.partition_no=i.partition_no AND n.generation=i.generation AND n.original=i.original
          AND n.scope_key=$9 AND n.registration=i.registration::text AND n.capture_id=i.capture_id::text
          AND n.source_partition=i.source_partition AND n.scope=$10::jsonb AND NOT n.retired
          AND nc.epoch=p.epoch AND nc.position<=p.position))`,
          [
            home,
            generation,
            dep.original ?? HOME,
            k.partition,
            k.source,
            k.scope,
            row.registration,
            row.capture_id,
            digest({ source: k.source, scope: k.scope }),
            json(key),
          ],
        )
      ).rows[0] ?? null,
  );
}

/** Additive public-output locator ABI. The delivered native factory still decides support and custody. */
type ScopedNativeCustody = {
  [K in keyof NativeLibrarySourceCustody]: (
    input: Omit<Parameters<NativeLibrarySourceCustody[K]>[0], 'identity'> & {
      identity: S.IdentityScopeLibraryIdentity;
    },
  ) => ReturnType<NativeLibrarySourceCustody[K]>;
};
const nativeCustody = (config: Parameters<typeof createNativeLibrarySourceCustody>[0]) =>
  createNativeLibrarySourceCustody(config) as ScopedNativeCustody;

type Attempt = {
  job_id: string;
  job_epoch: string;
  attempt: IdentityNativeReceipt;
  state: 'active' | 'finished' | 'cancelled';
  revision: string;
};
type Completion = {
  version: string;
  source_generation: string;
  capture_id: string;
  attempt: IdentityNativeReceipt;
  seal: LibraryScopeEffectSeal | null;
  after_key: LibraryExpectedEffectAfter | null;
  complete: boolean;
};
const attemptParams = (key: S.IdentityScopeKey, row: Head, job: S.IdentityScopeFinishInput['job']) => [
  ...params(key),
  row.registration,
  job.jobId,
  job.epoch.toString(),
];

async function attemptAt(
  tx: CommandTransaction,
  key: S.IdentityScopeKey,
  row: Head,
  job: S.IdentityScopeFinishInput['job'],
  measured: Work,
): Promise<Attempt | null> {
  return (
    (
      await query(
        tx,
        measured,
        `SELECT a.* FROM semantic.identity_scope_attempt a
    JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(a.partition_no,a.transaction_id)
      AND c.xmin=a.xmin AND c.purpose IN ('identity-scope-preparation','identity-scope-finish','identity-scope-cancellation')
    JOIN core.partition p ON p.partition_no=a.partition_no AND p.epoch=c.epoch AND p.position>=c.position
    WHERE a.partition_no=$1 AND a.source_key=$2 AND a.scope_id=$3 AND a.registration=$4 AND a.job_id=$5 AND a.job_epoch=$6
      AND p.write_state='active' AND p.moved_to IS NULL FOR UPDATE OF a`,
        attemptParams(key, row, job),
      )
    ).rows[0] ?? null
  );
}

/** Exact additive read-only receiving ABI. Absence is foreign unavailability, never a manufactured receipt. */
type ReadReceivingSelection = (
  pool: Pool,
  selection: IdentityReceivingSelection,
  context: { deadline: number },
) => Promise<IdentityReceivingRecord | null>;
async function receivingSelection(pool: Pool, selection: IdentityReceivingSelection, deadline: number) {
  const producer: typeof import('./identity-receiving-effects.ts') & {
    readIdentityReceivingSelection?: ReadReceivingSelection;
  } = await import('./identity-receiving-effects.ts');
  return producer.readIdentityReceivingSelection?.(pool, selection, { deadline }) ?? null;
}
function sameLibrarySource(a: S.IdentityScopeLibraryIdentity, b: S.IdentityScopeLibraryIdentity): boolean {
  // ReceivingEpoch/effectKey bind the individual native effect, not the Source's registration identity.
  const { effectKey: _ae, receivingEpoch: _ar, ...left } = a;
  const { effectKey: _be, receivingEpoch: _br, ...right } = b;
  return same(left, right);
}
function matchesSelection(
  record: IdentityReceivingRecord,
  selection: IdentityReceivingSelection,
  key: S.IdentityScopeKey,
): boolean {
  return (
    key.source.kind === 'library' &&
    same(record.job, selection.job) &&
    record.original === selection.original &&
    record.effectKey === selection.effectKey &&
    record.owner === selection.owner &&
    record.source.id === selection.sourceId &&
    record.source.scope === key.scopeId &&
    record.source.scope === selection.scope &&
    record.source.disposition === selection.disposition &&
    record.source.incarnation === record.source.native.identity.incarnation &&
    record.source.generation === record.source.native.identity.generation &&
    sameLibrarySource(key.source.identity, record.source.native.identity) &&
    (!selection.capture ||
      (same(selection.capture.identity, record.source.native.identity) &&
        selection.capture.frontier.captureId === record.source.native.captureId))
  );
}
async function receivingCustody(
  pool: Pool,
  record: IdentityReceivingRecord,
  deadline: number,
  measured: Work,
): Promise<boolean> {
  if (!record.applied || Date.now() >= deadline) return false;
  const applied = record.applied.receipt;
  // Own Semantic control authority, at its proper released home. No Library SQL or participant ACK.
  return withReadTransaction(
    pool,
    async (tx) =>
      (
        await query(
          tx,
          measured,
          `SELECT 1 FROM semantic.identity_epoch_job j
    JOIN core.partition p ON p.partition_no=j.partition_no AND p.write_state='active' AND p.moved_to IS NULL
    JOIN semantic.identity_epoch_receiving_plan r ON r.partition_no=j.partition_no AND r.job_id=j.job_id AND r.job_epoch=j.epoch
    JOIN semantic.identity_epoch_native_commit plan ON (plan.partition_no,plan.transaction_id)=(r.partition_no,r.transaction_id)
      AND plan.xmin=r.xmin AND plan.purpose='identity-receiving-plan'
    JOIN semantic.identity_epoch_effect_receipt e ON e.partition_no=r.partition_no AND e.job_id=r.job_id AND e.effect_key=r.effect_key AND e.step='library-private-follow-counts'
    JOIN semantic.identity_epoch_receiving_custody a ON (a.partition_no,a.job_id,a.effect_key)=(e.partition_no,e.job_id,e.effect_key)
    JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(a.partition_no,a.transaction_id)
      AND c.xmin=a.xmin AND c.purpose='identity-receiving-custody' AND c.epoch=p.epoch AND p.position>=c.position
    WHERE j.partition_no=$1 AND j.job_id=$2 AND j.epoch=$3 AND j.state IN ('pending','published')
      AND r.effect_key=$4 AND r.transaction_id=$5 AND plan.epoch=$6 AND plan.position=$7
      AND r.binding_digest=$8 AND r.binding->>'scopeDigest'=j.scope_digest
      AND (e.native_partition,e.native_epoch,e.native_position,e.native_transaction_id)=($9,$10,$11,$12)`,
          [
            identityJobPartition(record.job),
            record.job.jobId,
            record.job.epoch.toString(),
            record.effectKey,
            record.plan.transactionId,
            record.plan.epoch,
            record.plan.position.toString(),
            digest({
              job: record.job,
              original: record.original,
              effectKey: record.effectKey,
              owner: record.owner,
              step: record.step,
              version: record.version,
              scopeDigest: record.scopeDigest,
              source: record.source,
            }),
            applied.partition,
            applied.epoch,
            applied.position.toString(),
            applied.transactionId,
          ],
        )
      ).rowCount === 1,
  );
}
function persistedSeal(seal: LibraryScopeEffectSeal): LibraryScopeEffectSeal {
  // Serialized brands are locators only. The native verifier MUST resolve the actual committed seal.
  return {
    ...seal,
    key: { ...seal.key, job: { ...seal.key.job, epoch: BigInt(seal.key.job.epoch) } },
    receipt: { ...seal.receipt, position: BigInt(seal.receipt.position) },
  };
}

/** Release one directory obligation only while the SAME bridge is open. A tombstone fences late sends. */
async function releaseDirectory(
  pool: Pool,
  key: S.IdentityScopeKey,
  row: Head,
  dep: Dependency,
  deadline: number,
  measured: Work,
): Promise<boolean> {
  if (dep.directory_home === null) return dep.sending_known; // Only a known unsent row proves no remote obligation.
  const home = dep.directory_home;
  if (!dep.directory_generation) return false;
  const k = identityScopeAddress(key);
  const values = [
    home,
    dep.directory_generation,
    dep.original ?? HOME,
    k.partition,
    k.source,
    k.scope,
    row.registration,
    row.capture_id,
  ];
  const issued = await runCommand(pool, { partition: home, deadline }, async (tx) => {
    const prior = await query(
      tx,
      measured,
      `SELECT 1 FROM semantic.identity_scope_directory_release
      WHERE partition_no=$1 AND generation=$2 AND original=$3 AND source_partition=$4 AND source_key=$5 AND scope_id=$6 AND registration=$7 AND capture_id=$8`,
      values,
    );
    if (prior.rowCount) return { value: true, events: [] };
    if (dep.original) {
      const nativeBridge = (
        await query(
          tx,
          measured,
          `SELECT job_id FROM semantic.identity_epoch_prearm_bridge
        WHERE partition_no=$1 AND generation=$2 FOR UPDATE`,
          [home, dep.directory_generation],
        )
      ).rows[0];
      if (!nativeBridge || nativeBridge.job_id !== null) return { value: false, events: [] };
    }
    await query(
      tx,
      measured,
      `INSERT INTO semantic.identity_scope_bridge(partition_no,generation) VALUES($1,$2) ON CONFLICT DO NOTHING`,
      [home, dep.directory_generation],
    );
    const bridge = (
      await query(
        tx,
        measured,
        `SELECT closed_job FROM semantic.identity_scope_bridge
      WHERE partition_no=$1 AND generation=$2 FOR UPDATE`,
        [home, dep.directory_generation],
      )
    ).rows[0];
    if (!bridge || bridge.closed_job !== null) return { value: false, events: [] };
    // An uncertain in-flight enrollment must retry against this changed bridge and the release tombstone.
    await query(
      tx,
      measured,
      `UPDATE semantic.identity_scope_bridge SET version=version+1 WHERE partition_no=$1 AND generation=$2`,
      [home, dep.directory_generation],
    );
    if (dep.original)
      await query(
        tx,
        measured,
        `DELETE FROM semantic.identity_epoch_prearm_inverse
      WHERE partition_no=$1 AND generation=$2 AND original=$3 AND scope_key=$4
        AND registration=$5 AND capture_id=$6 AND source_partition=$7`,
        [
          home,
          dep.directory_generation,
          dep.original,
          digest({ source: k.source, scope: k.scope }),
          row.registration,
          row.capture_id,
          k.partition,
        ],
      );
    await query(
      tx,
      measured,
      `DELETE FROM semantic.identity_scope_inverse
      WHERE partition_no=$1 AND generation=$2 AND original=$3 AND source_partition=$4 AND source_key=$5 AND scope_id=$6 AND registration=$7 AND capture_id=$8`,
      values,
    );
    await query(
      tx,
      measured,
      `INSERT INTO semantic.identity_scope_directory_release
      (partition_no,generation,original,source_partition,source_key,scope_id,registration,capture_id,transaction_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [...values, currentCommand(tx).transactionId],
    );
    recordIdentityEpochNativeCommit(tx, 'identity-scope-directory-release');
    return { value: true, events: [] };
  });
  if (!issued.value) return false;
  // Release directory home before taking the native receipt into Source-local custody.
  return withReadTransaction(
    pool,
    async (tx) =>
      (
        await query(
          tx,
          measured,
          `SELECT 1 FROM semantic.identity_scope_directory_release r
    JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(r.partition_no,r.transaction_id)
      AND c.xmin=r.xmin AND c.purpose='identity-scope-directory-release'
    JOIN core.partition p ON p.partition_no=r.partition_no AND p.epoch=c.epoch AND p.position>=c.position
    WHERE r.partition_no=$1 AND r.generation=$2 AND r.original=$3 AND r.source_partition=$4 AND r.source_key=$5 AND r.scope_id=$6 AND r.registration=$7 AND r.capture_id=$8
      AND p.write_state='active' AND p.moved_to IS NULL`,
          values,
        )
      ).rowCount === 1,
  );
}

export function createIdentityScopedObservations(pool: Pool): S.IdentityScopedObservations {
  async function advance(
    key: S.IdentityScopeKey,
    deadline: number,
    measured: Work,
    allowance?: WorkAllowance,
  ): Promise<S.IdentityScopeRegistrationResult> {
    const k = identityScopeAddress(key);
    if (key.source.kind === 'library' && key.source.identity.scope === 'public_output') {
      if (!allowance) return fail('custody_missing', measured);
      const result = await readPublicIdentityOutputCaptureCurrent(pool, key, { deadline, allowance });
      charge(measured, result.work);
      measured.outputWork = result.work;
      if (result.status !== 'current' || !same(result.key, key)) return fail('source_unready', measured);
      return {
        status: 'registered',
        observation: { key, captureId: result.capture.captureId, committedRevision: result.committedRevision },
        work: measured,
      };
    }
    let row = await withReadTransaction(pool, (tx) => head(tx, key, measured));
    if (!row) return fail('summary_missing', measured);
    if (!same(row.source, key.source)) return fail('owner_moved', measured, 'stale');
    if (row.state === 'retired' || row.state === 'retiring') return fail('source_unready', measured);
    if (!row.scan_complete) {
      if (key.source.kind === 'public') {
        const prior = row;
        const nativeAssociation1 = prepayIdentityScopeNativeAssociation(pool, deadline);
        await withSingleCommandAttempt(() =>
          runCommand(pool, { partition: k.partition, deadline: nativeAssociation1.deadline }, async (tx) => {
            bindIdentityScopeNativeAssociation(tx, nativeAssociation1);
            const locked = await head(tx, key, measured, true);
            if (
              !locked ||
              locked.state === 'retiring' ||
              locked.state === 'retired' ||
              locked.registration !== prior.registration ||
              locked.capture.kind !== 'public-locator' ||
              !(await verifyPublicIdentitySourceCaptureLocator(tx, locked.capture))
            )
              throw unavailable();
            const native = (
              await query(
                tx,
                measured,
                `SELECT home FROM semantic.identity_public_capture_home WHERE partition_no=$1 AND capture_id=$2 AND home=$3 AND complete`,
                [k.partition, locked.capture_id, locked.enrollment_home],
              )
            ).rows[0];
            if (!native) throw unavailable();
            await query(
              tx,
              measured,
              `INSERT INTO semantic.identity_scope_forward(partition_no,source_key,scope_id,registration,dependency,dependency_home)
            VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
              [...params(key), locked.registration, `home:${String(native.home).padStart(4, '0')}`, native.home],
            );
            await query(
              tx,
              measured,
              `UPDATE semantic.identity_scope_summary SET enrollment_home=enrollment_home+1,scan_complete=enrollment_home=4095 WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND enrollment_home=$4`,
              [...params(key), locked.enrollment_home],
            );
            return {
              value: null,
              events: [recordIdentityScopeNativeAssociation(tx, nativeAssociation1, key, 'capture')],
            };
          }),
        );
        return { status: 'pending', work: measured };
      }
      if (!allowance && row.capture.kind === 'library')
        allowance = { ...row.capture.allowance, reservationId: randomUUID() };
      if (key.source.kind !== 'library' || !allowance) return fail('capture_incomplete', measured);
      const identity = key.source.identity;
      const captureAllowance = allowance;
      const owner = nativeCustody({ pool });
      const captured =
        row.frontier?.driver === 'done'
          ? await owner.finishCapture({ identity, frontier: row.frontier, allowance: captureAllowance, deadline })
          : await owner.capturePage({
              identity,
              frontier: row.frontier,
              limit: 1,
              allowance: captureAllowance,
              deadline,
            });
      charge(measured, captured.work);
      if (captured.status === 'unavailable') return fail('source_unready', measured);
      const prior = row;
      const nativeAssociation2 = prepayIdentityScopeNativeAssociation(pool, deadline);
      await withSingleCommandAttempt(() =>
        runCommand(pool, { partition: k.partition, deadline: nativeAssociation2.deadline }, async (tx) => {
          bindIdentityScopeNativeAssociation(tx, nativeAssociation2);
          const locked = await head(tx, key, measured, true);
          if (
            !locked ||
            locked.state === 'retiring' ||
            locked.state === 'retired' ||
            locked.registration !== prior.registration ||
            !same(locked.frontier ?? {}, prior.frontier ?? {})
          )
            throw unavailable();
          if (captured.status === 'pending') {
            const originals = [...new Set(captured.rows.flatMap((r) => (r.subjectId ? [r.subjectId] : [])))];
            await query(
              tx,
              measured,
              `INSERT INTO semantic.identity_scope_forward(partition_no,source_key,scope_id,registration,dependency,original)
            SELECT $1,$2,$3,$4,o::text,o FROM unnest($5::uuid[]) o ON CONFLICT DO NOTHING`,
              [...params(key), row!.registration, originals],
            );
            await query(
              tx,
              measured,
              `UPDATE semantic.identity_scope_summary SET capture_id=$4,frontier=$5 WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3`,
              [...params(key), captured.frontier.captureId, json(captured.frontier)],
            );
          } else {
            // Source owner resolves the committed native capture and final writer fence on this command.
            const held = await owner.readAndHold({
              client: tx,
              at: currentCommand(tx).time,
              identity,
              captureId: captured.capture.captureId,
              holdId: locked.registration,
              allowance: captureAllowance,
              deadline,
            });
            charge(measured, held.work);
            if (held.status !== 'held') throw unavailable();
            await query(
              tx,
              measured,
              `UPDATE semantic.identity_scope_summary SET scan_complete=true,state='enrolling',capture_id=$4,capture=$5
            WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3`,
              [
                ...params(key),
                captured.capture.captureId,
                json({
                  kind: 'library',
                  capture: captured.capture,
                  frontier: prior.frontier,
                  allowance: captureAllowance,
                }),
              ],
            );
          }
          return {
            value: null,
            events: [recordIdentityScopeNativeAssociation(tx, nativeAssociation2, key, 'capture')],
          };
        }),
      );
      return { status: 'pending', work: measured };
    }
    const dep = await withReadTransaction(
      pool,
      async (tx) =>
        (
          await query(
            tx,
            measured,
            `SELECT dependency,original,dependency_home,sending_known,directory_home,directory_generation,directory_group FROM semantic.identity_scope_forward
      WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND registration=$4 AND ticket IS NULL ORDER BY dependency LIMIT 1`,
            [...params(key), row!.registration],
          )
        ).rows[0] as Dependency | undefined,
    );
    if (dep) {
      const ticket = await enroll(pool, key, row, dep, deadline, measured);
      if (!ticket) return { status: 'pending', work: measured };
      const nativeAssociation3 = prepayIdentityScopeNativeAssociation(pool, deadline);
      await withSingleCommandAttempt(() =>
        runCommand(pool, { partition: k.partition, deadline: nativeAssociation3.deadline }, async (tx) => {
          bindIdentityScopeNativeAssociation(tx, nativeAssociation3);
          const locked = await head(tx, key, measured, true);
          if (
            !locked ||
            locked.state === 'retiring' ||
            locked.state === 'retired' ||
            locked.registration !== row!.registration ||
            locked.capture_id !== row!.capture_id
          )
            throw unavailable();
          const enrolled = await query(
            tx,
            measured,
            `UPDATE semantic.identity_scope_forward SET ticket=$6 WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND registration=$4 AND dependency=$5 AND ticket IS NULL`,
            [...params(key), row!.registration, dep.dependency, json(ticket)],
          );
          if (enrolled.rowCount === 0) return noEffect(null);
          return {
            value: null,
            events: [
              recordIdentityScopeNativeAssociation(tx, nativeAssociation3, key, 'enrollment', {
                dependency: dep.dependency,
              }),
            ],
          };
        }),
      );
      return { status: 'pending', work: measured };
    }
    const nativeAssociation4 = prepayIdentityScopeNativeAssociation(pool, deadline);
    return (
      await withSingleCommandAttempt(() =>
        runCommand<S.IdentityScopeRegistrationResult>(
          pool,
          { partition: k.partition, deadline: nativeAssociation4.deadline },
          async (tx) => {
            bindIdentityScopeNativeAssociation(tx, nativeAssociation4);
            const locked = await head(tx, key, measured, true);
            if (
              !locked ||
              locked.state === 'retiring' ||
              locked.state === 'retired' ||
              locked.registration !== row!.registration ||
              !locked.scan_complete ||
              !(await proofCurrent(tx, key, locked, measured, true))
            )
              return noEffect(fail('source_unready', measured));
            if (locked.active !== 0) return noEffect(fail('pending_claim', measured));
            const unresolved = await query(
              tx,
              measured,
              `SELECT 1 FROM semantic.identity_scope_forward WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND registration=$4 AND ticket IS NULL ORDER BY dependency LIMIT 1`,
              [...params(key), locked.registration],
            );
            if (unresolved.rowCount) return noEffect({ status: 'pending', work: measured });
            if (isReadyScopeState(locked.state))
              return noEffect({ status: 'registered', observation: observation(key, locked), work: measured });
            if (locked.state !== 'ready') {
              await query(
                tx,
                measured,
                `UPDATE semantic.identity_scope_summary SET state='ready',revision=revision+1 WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3`,
                params(key),
              );
              locked.revision = (BigInt(locked.revision) + 1n).toString();
            }
            return {
              value: { status: 'registered', observation: observation(key, locked), work: measured },
              events: [recordIdentityScopeNativeAssociation(tx, nativeAssociation4, key, 'ready')],
            };
          },
        ),
      )
    ).value;
  }
  async function finishScope(input: S.IdentityScopeFinishInput): Promise<S.IdentityScopeFinishResult> {
    const measured = work();
    if (input.key.source.kind === 'library' && input.key.source.identity.scope === 'public_output')
      return fail('custody_missing', measured);
    if ((input.records?.length ?? 0) > 8) throw new RangeError('Finish receiving hints must be bounded');
    if (Date.now() >= input.deadline) return fail('deadline', measured);
    const nativeAssociation5 = prepayIdentityScopeNativeAssociation(pool, input.deadline);
    input = { ...input, deadline: nativeAssociation5.deadline };
    const budget = new NativeCollectionWork(input.allowance, input.deadline);
    const snapshot = await withSingleCommandAttempt(() =>
      runCommand(
        pool,
        { partition: identityScopeAddress(input.key).partition, deadline: nativeAssociation5.deadline },
        async (tx) => {
          bindIdentityScopeNativeAssociation(tx, nativeAssociation5);
          const row = await head(tx, input.key, measured, true);
          if (!row || !same(row.source, input.key.source) || row.state === 'retired') return noEffect(null);
          const attempt = await attemptAt(tx, input.key, row, input.job, measured);
          if (!attempt || !same(attempt.attempt, input.attempt) || attempt.state === 'cancelled') return noEffect(null);
          await query(
            tx,
            measured,
            `UPDATE semantic.identity_scope_summary SET maintenance_allowance=$4
          WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3`,
            [...params(input.key), json(input.allowance)],
          );
          const progress = (
            await query(
              tx,
              measured,
              `SELECT * FROM semantic.identity_scope_completion
        WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND registration=$4 AND job_id=$5 AND job_epoch=$6`,
              attemptParams(input.key, row, input.job),
            )
          ).rows[0] as Completion | undefined;
          return {
            value: { row, attempt, progress },
            events: [
              recordIdentityScopeNativeAssociation(tx, nativeAssociation5, input.key, 'progress', { job: input.job }),
            ],
          };
        },
      ),
    );
    if (!snapshot.value) return fail('custody_missing', measured);
    const { row, attempt, progress } = snapshot.value;
    if (attempt.state === 'finished')
      return { status: 'finished', scope: input.key, committedRevision: BigInt(attempt.revision), work: measured };
    const pending = (): S.IdentityScopeFinishResult => ({
      status: 'pending',
      scope: input.key,
      committedRevision: BigInt(row.revision),
      work: measured,
    });
    // Public catalogue is a different native producer. Library seals cannot close public projection work.
    // The missing public effect enumeration/receiving ABI is named in the owner contract.
    if (input.key.source.kind === 'public') {
      const nativeAssociation6 = prepayIdentityScopeNativeAssociation(pool, input.deadline);
      await withSingleCommandAttempt(() =>
        runCommand(
          pool,
          { partition: identityScopeAddress(input.key).partition, deadline: nativeAssociation6.deadline },
          async (tx) => {
            bindIdentityScopeNativeAssociation(tx, nativeAssociation6);
            const locked = await head(tx, input.key, measured, true);
            if (
              !locked ||
              locked.registration !== row.registration ||
              locked.capture_id !== row.capture_id ||
              locked.capture.kind !== 'public-locator' ||
              !same(locked.source, input.key.source) ||
              !(await verifyPublicIdentitySourceCaptureLocator(tx, locked.capture))
            )
              throw unavailable();
            const current = await attemptAt(tx, input.key, locked, input.job, measured);
            if (!current || current.state !== 'active' || !same(current.attempt, input.attempt)) throw unavailable();
            // Retained native public expected-state head. No Library membership or seal is stored here.
            const stored = await query(
              tx,
              measured,
              `INSERT INTO semantic.identity_scope_completion
          (partition_no,source_key,scope_id,registration,job_id,job_epoch,source_generation,capture_id,attempt)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
              [
                ...attemptParams(input.key, locked, input.job),
                locked.capture.definition,
                locked.capture_id,
                json(input.attempt),
              ],
            );
            if (stored.rowCount === 0) return noEffect(null);
            return {
              value: null,
              events: [
                recordIdentityScopeNativeAssociation(tx, nativeAssociation6, input.key, 'progress', { job: input.job }),
              ],
            };
          },
        ),
      );
      return fail('custody_missing', measured);
    }
    if (row.capture.kind !== 'library') return fail('capture_incomplete', measured);
    const identity = input.key.source.identity;
    const nativeKey: LibraryScopeEffectsKey = {
      job: input.job,
      sourceIdentity: identity as NativeSourceIdentity,
      scope: input.key.scopeId,
    };
    const validProgress =
      progress &&
      progress.source_generation === identity.generation &&
      progress.capture_id === row.capture_id &&
      same(progress.attempt, input.attempt);
    const after = validProgress ? progress.after_key : null;
    const page = await budget.compose((allowance) =>
      readLibraryScopeEffectsPage(pool, { ...nativeKey, after, limit: 1, allowance, deadline: input.deadline }),
    );
    charge(measured, page.work);
    // Never consume an unsealed prefix: it could omit an earlier newly enrolled selection.
    if (page.status !== 'sealed') return pending();
    if (
      !same(page.seal.key, nativeKey) ||
      !page.seal.generation ||
      !page.seal.version ||
      page.rows.length > 1 ||
      (!page.exhausted && (page.after === null || same(page.after, after ?? {})))
    )
      return pending();
    const sealChanged =
      !!progress &&
      (!validProgress ||
        (progress.seal !== null && !same(persistedSeal(progress.seal), page.seal)) ||
        (progress.seal === null && progress.after_key !== null));
    if (sealChanged) {
      const nativeAssociation7 = prepayIdentityScopeNativeAssociation(pool, input.deadline);
      await withSingleCommandAttempt(() =>
        runCommand(
          pool,
          { partition: identityScopeAddress(input.key).partition, deadline: nativeAssociation7.deadline },
          async (tx) => {
            bindIdentityScopeNativeAssociation(tx, nativeAssociation7);
            const locked = await head(tx, input.key, measured, true);
            if (!(locked?.registration === row.registration && same(locked.source, input.key.source)))
              return noEffect(null);
            const reset = await query(
              tx,
              measured,
              `UPDATE semantic.identity_scope_completion SET seal=NULL,after_key=NULL,complete=false,version=version+1,
            source_generation=$7,capture_id=$8,attempt=$9
            WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND registration=$4 AND job_id=$5 AND job_epoch=$6 AND version=$10`,
              [
                ...attemptParams(input.key, row, input.job),
                identity.generation,
                row.capture_id,
                json(input.attempt),
                progress!.version,
              ],
            );
            if (reset.rowCount === 0) return noEffect(null);
            return {
              value: null,
              events: [
                recordIdentityScopeNativeAssociation(tx, nativeAssociation7, input.key, 'progress', { job: input.job }),
              ],
            };
          },
        ),
      );
      return pending();
    }
    for (const selection of page.rows) {
      if (
        !same(selection.job, input.job) ||
        selection.scope !== input.key.scopeId ||
        selection.sourceId !== identity.collectionId
      )
        return pending();
      const record = await receivingSelection(pool, selection, input.deadline);
      if (
        !record ||
        !record.applied ||
        !matchesSelection(record, selection, input.key) ||
        !(await receivingCustody(pool, record, input.deadline, measured))
      )
        return pending();
    }
    if (Date.now() >= input.deadline) return fail('deadline', measured);
    const nativeAssociation8 = prepayIdentityScopeNativeAssociation(pool, input.deadline);
    return (
      await withSingleCommandAttempt(() =>
        runCommand<S.IdentityScopeFinishResult>(
          pool,
          { partition: identityScopeAddress(input.key).partition, deadline: nativeAssociation8.deadline },
          async (tx) => {
            bindIdentityScopeNativeAssociation(tx, nativeAssociation8);
            const locked = await head(tx, input.key, measured, true);
            if (
              !locked ||
              locked.registration !== row.registration ||
              locked.capture_id !== row.capture_id ||
              !same(locked.source, input.key.source) ||
              locked.state === 'retired'
            )
              return noEffect(fail('source_unready', measured, 'stale'));
            const current = await attemptAt(tx, input.key, locked, input.job, measured);
            if (!current || !same(current.attempt, input.attempt) || current.state === 'cancelled')
              return noEffect(fail('custody_missing', measured));
            if (current.state === 'finished')
              return noEffect({
                status: 'finished',
                scope: input.key,
                committedRevision: BigInt(current.revision),
                work: measured,
              });
            const saved = (
              await query(
                tx,
                measured,
                `SELECT version FROM semantic.identity_scope_completion
        WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND registration=$4 AND job_id=$5 AND job_epoch=$6 FOR UPDATE`,
                attemptParams(input.key, locked, input.job),
              )
            ).rows[0];
            if ((saved?.version ?? null) !== (progress?.version ?? null)) return noEffect(pending());
            // Revalidate retained custody, not a newly manufactured capture or effect receipt.
            if (!(await proofCurrent(tx, input.key, locked, measured, true, budget)))
              return noEffect(fail('source_unready', measured));
            if (page.exhausted && !(await verifyLibraryScopeEffectsSeal(tx, nativeKey, page.seal))) {
              const invalidated = await query(
                tx,
                measured,
                `UPDATE semantic.identity_scope_completion SET seal=NULL,after_key=NULL,complete=false,version=version+1
          WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND registration=$4 AND job_id=$5 AND job_epoch=$6`,
                attemptParams(input.key, locked, input.job),
              );
              if (invalidated.rowCount === 0) return noEffect(pending());
              return {
                value: pending(),
                events: [
                  recordIdentityScopeNativeAssociation(tx, nativeAssociation8, input.key, 'progress', {
                    job: input.job,
                  }),
                ],
              };
            }
            await query(
              tx,
              measured,
              `INSERT INTO semantic.identity_scope_completion
        (partition_no,source_key,scope_id,registration,job_id,job_epoch,source_generation,capture_id,attempt,seal,after_key,complete)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT(partition_no,source_key,scope_id,registration,job_id,job_epoch) DO UPDATE
        SET seal=excluded.seal,after_key=excluded.after_key,complete=excluded.complete,version=semantic.identity_scope_completion.version+1`,
              [
                ...attemptParams(input.key, locked, input.job),
                identity.generation,
                locked.capture_id,
                json(input.attempt),
                json(page.seal),
                page.after ? json(page.after) : null,
                page.exhausted,
              ],
            );
            if (!page.exhausted)
              return {
                value: pending(),
                events: [
                  recordIdentityScopeNativeAssociation(tx, nativeAssociation8, input.key, 'progress', {
                    job: input.job,
                  }),
                ],
              };
            if (locked.active < 1) throw unavailable();
            const revision = BigInt(locked.revision) + 1n;
            await query(
              tx,
              measured,
              `UPDATE semantic.identity_scope_attempt SET state='finished',revision=$7,transaction_id=$8
        WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND registration=$4 AND job_id=$5 AND job_epoch=$6 AND state='active'`,
              [...attemptParams(input.key, locked, input.job), revision.toString(), currentCommand(tx).transactionId],
            );
            await query(
              tx,
              measured,
              `UPDATE semantic.identity_scope_summary SET active=active-1,revision=revision+1,
        state=CASE WHEN state='retiring' THEN state ELSE 'repair' END WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3`,
              params(input.key),
            );
            return {
              value: { status: 'finished', scope: input.key, committedRevision: revision, work: measured },
              events: [
                recordIdentityScopeNativeAssociation(tx, nativeAssociation8, input.key, 'finish', { job: input.job }),
              ],
            };
          },
        ),
      )
    ).value;
  }

  async function retireScope(input: S.IdentityScopeRetireInput): Promise<S.IdentityScopeRetireResult> {
    const measured = work();
    const partition = identityScopeAddress(input.key).partition;
    if (input.key.source.kind === 'library' && input.key.source.identity.scope === 'public_output')
      return fail('custody_missing', measured);
    if ((input.receiving?.length ?? 0) > 8) throw new RangeError('Retirement receiving hints must be bounded');
    if (Date.now() >= input.deadline) return fail('deadline', measured);
    const snapshot = await runCommand(pool, { partition, deadline: input.deadline }, async (tx) => {
      const row = await head(tx, input.key, measured, true);
      if (!row || !same(row.source, input.key.source)) return { value: null, events: [] };
      if (row.state !== 'retiring' && row.state !== 'retired') {
        await query(
          tx,
          measured,
          `UPDATE semantic.identity_scope_summary SET state='retiring',revision=revision+1,maintenance_allowance=$4
          WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3`,
          [...params(input.key), json(input.allowance)],
        );
        row.state = 'retiring';
        row.revision = (BigInt(row.revision) + 1n).toString();
      }
      const active = (
        await query(
          tx,
          measured,
          `SELECT job_id,job_epoch,attempt FROM semantic.identity_scope_attempt
        WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND registration=$4 AND state='active'
        ORDER BY job_id,job_epoch LIMIT 1`,
          [...params(input.key), row.registration],
        )
      ).rows[0] as Attempt | undefined;
      const dependency = (
        await query(
          tx,
          measured,
          `SELECT * FROM semantic.identity_scope_forward
        WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND registration=$4 ORDER BY dependency LIMIT 1`,
          [...params(input.key), row.registration],
        )
      ).rows[0] as Dependency | undefined;
      return { value: { row, active, dependency }, events: [] };
    });
    if (!snapshot.value) return fail('summary_missing', measured);
    const { row, active, dependency } = snapshot.value;
    if (row.state === 'retired') return { status: 'retired', work: measured };
    if (active) {
      const result = await finishScope({
        key: input.key,
        job: { jobId: active.job_id, epoch: BigInt(active.job_epoch) },
        attempt: active.attempt,
        ...(input.receiving ? { records: input.receiving } : {}),
        allowance: input.allowance,
        deadline: input.deadline,
      });
      for (const axis of ['rows', 'points', 'statements', 'bytes'] as const) measured[axis] += result.work[axis];
      return { status: 'pending', work: measured };
    }
    if (dependency) {
      const released = await releaseDirectory(pool, input.key, row, dependency, input.deadline, measured);
      if (!released) return { status: 'pending', work: measured };
      await runCommand(pool, { partition, deadline: input.deadline }, async (tx) => {
        const locked = await head(tx, input.key, measured, true);
        if (!locked || locked.registration !== row.registration || locked.state !== 'retiring') throw unavailable();
        await query(
          tx,
          measured,
          `DELETE FROM semantic.identity_scope_forward
          WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND registration=$4 AND dependency=$5`,
          [...params(input.key), row.registration, dependency.dependency],
        );
        return { value: null, events: [] };
      });
      return { status: 'pending', work: measured };
    }
    const budget = new NativeCollectionWork(input.allowance, input.deadline);
    return (
      await runCommand<S.IdentityScopeRetireResult>(pool, { partition, deadline: input.deadline }, async (tx) => {
        const locked = await head(tx, input.key, measured, true);
        if (
          !locked ||
          !same(locked.source, input.key.source) ||
          locked.registration !== row.registration ||
          locked.state !== 'retiring' ||
          locked.active !== 0
        )
          return { value: { status: 'pending', work: measured }, events: [] };
        const outstanding = await query(
          tx,
          measured,
          `SELECT 1 FROM semantic.identity_scope_forward
        WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND registration=$4 LIMIT 1`,
          [...params(input.key), row.registration],
        );
        if (outstanding.rowCount) return { value: { status: 'pending', work: measured }, events: [] };
        // Old cursor bases already fail the retiring summary. No caller hint can release a native hold.
        if (input.key.source.kind === 'library' && locked.capture.kind === 'library' && locked.scan_complete) {
          const identity = input.key.source.identity;
          const released = await budget.compose((allowance) =>
            nativeCustody(currentCommandResources(tx)).releaseHold({
              client: tx,
              at: currentCommand(tx).time,
              identity,
              captureId: locked.capture_id,
              holdId: locked.registration,
              allowance,
              deadline: input.deadline,
            }),
          );
          charge(measured, released.work);
          if (released.status !== 'released') return { value: fail('custody_missing', measured), events: [] };
        }
        await query(
          tx,
          measured,
          `UPDATE semantic.identity_scope_summary SET state='retired',revision=revision+1
        WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3`,
          params(input.key),
        );
        recordIdentityEpochNativeCommit(tx, 'identity-scope-retirement');
        return { value: { status: 'retired', work: measured }, events: [] };
      })
    ).value;
  }

  return {
    async register(input) {
      const measured = work();
      if (input.capture.kind === 'public-output') {
        const result = await readPublicIdentityOutputCaptureCurrent(pool, input.capture.capture, {
          deadline: input.deadline,
          allowance: input.capture.allowance,
        });
        charge(measured, result.work);
        measured.outputWork = result.work;
        if (result.status !== 'current' || !same(result.key, input.key)) return fail('capture_incomplete', measured);
        return {
          status: 'registered',
          observation: {
            key: input.key,
            captureId: input.capture.capture.captureId,
            committedRevision: result.committedRevision,
          },
          work: measured,
        };
      }
      const k = identityScopeAddress(input.key);
      if (Date.now() >= input.deadline) return fail('deadline', measured);
      let capture: S.IdentityScopeCapture | PublicLocator = input.capture;
      let captureId: string;
      if (input.key.source.kind === 'public' && input.capture.kind === 'public') {
        const locator = publicIdentityCaptureLocator(input.capture.capture);
        if (!locator || !same(locator.source, input.key.source.identity)) return fail('capture_incomplete', measured);
        capture = { kind: 'public-locator', ...locator };
        captureId = locator.captureId;
      } else if (
        input.key.source.kind === 'library' &&
        input.capture.kind === 'library' &&
        same(input.key.source.identity, input.capture.capture.identity)
      )
        captureId = input.capture.capture.captureId;
      else return fail('source_unready', measured);
      const nativeAssociation = prepayIdentityScopeNativeAssociation(pool, input.deadline);
      await withSingleCommandAttempt(() =>
        runCommand(pool, { partition: k.partition, deadline: nativeAssociation.deadline }, async (tx) => {
          bindIdentityScopeNativeAssociation(tx, nativeAssociation);
          if (!(await ownerCurrent(tx, input.key))) throw unavailable();
          if (capture.kind === 'public-locator' && !(await verifyPublicIdentitySourceCaptureLocator(tx, capture)))
            throw unavailable();
          const inserted = await query(
            tx,
            measured,
            `INSERT INTO semantic.identity_scope_summary(partition_no,source_key,scope_id,source,capture_id,capture,scan_complete,state)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
            [
              ...params(input.key),
              json(input.key.source),
              captureId,
              json(capture),
              false,
              capture.kind === 'public-locator' ? 'enrolling' : 'capturing',
            ],
          );
          const locked = await head(tx, input.key, measured, true);
          if (!locked || locked.state === 'retiring') throw unavailable();
          if (locked.state === 'retired') {
            await query(
              tx,
              measured,
              `UPDATE semantic.identity_scope_summary SET source=$4,capture_id=$5,capture=$6,
            registration=gen_random_uuid(),state=$7,revision=revision+1,active=0,frontier=NULL,
            scan_complete=false,enrollment_home=0,maintenance_allowance=NULL WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3`,
              [
                ...params(input.key),
                json(input.key.source),
                captureId,
                json(capture),
                capture.kind === 'public-locator' ? 'enrolling' : 'capturing',
              ],
            );
          } else if (!same(locked.source, input.key.source)) throw unavailable();
          else if (inserted.rowCount === 0) return noEffect(null);
          return {
            value: null,
            events: [recordIdentityScopeNativeAssociation(tx, nativeAssociation, input.key, 'registration')],
          };
        }),
      );
      return advance(
        input.key,
        nativeAssociation.deadline,
        measured,
        input.capture.kind === 'library' ? input.capture.allowance : undefined,
      );
    },
    async arm(input) {
      const measured = work();
      if (Date.now() >= input.deadline) return fail('deadline', measured);
      if (!same(input.receiving.job, input.job)) return fail('custody_missing', measured);
      // The selection is only a locator. Resolve the real committed record before taking the Source lock.
      const record = await receivingSelection(pool, input.receiving, input.deadline);
      if (!record || !matchesSelection(record, input.receiving, input.key)) return fail('custody_missing', measured);
      return (
        await runCommand<S.IdentityScopeArmResult>(
          pool,
          {
            partition: identityScopeAddress(input.key).partition,
            deadline: input.deadline,
          },
          async (tx) => {
            const row = await head(tx, input.key, measured, true);
            if (!row || row.state === 'retired' || !(await proofCurrent(tx, input.key, row, measured, true)))
              return { value: fail('source_unready', measured), events: [] };
            // Post-admission delivery reconciles the native pre-arm obligation; it never creates one late.
            const active = await attemptAt(tx, input.key, row, input.job, measured);
            if (!active || active.state !== 'active' || !same(active.attempt, input.attempt))
              return { value: fail('custody_missing', measured), events: [] };
            return { value: { status: 'armed', scope: input.key, job: input.job, work: measured }, events: [] };
          },
        )
      ).value;
    },
    finish: finishScope,
    async revalidate(input) {
      const measured = work();
      if (!same(input.key, input.expected.key)) return fail('source_unready', measured, 'stale');
      if (Date.now() >= input.deadline) return fail('deadline', measured);
      if (input.key.source.kind === 'library' && input.key.source.identity.scope === 'public_output') {
        if (!input.allowance) return fail('custody_missing', measured);
        const options = { deadline: input.deadline, allowance: input.allowance };
        const result = input.tx
          ? await lockPublicIdentityOutputCaptureCurrent(input.tx, input.key, {
              ...options,
              pool,
              at: currentCommand(input.tx).time,
            })
          : await readPublicIdentityOutputCaptureCurrent(pool, input.key, options);
        charge(measured, result.work);
        measured.outputWork = result.work;
        if (
          result.status !== 'current' ||
          !same(result.key, input.key) ||
          result.capture.captureId !== input.expected.captureId ||
          result.committedRevision !== input.expected.committedRevision
        )
          return fail('source_unready', measured, 'stale');
        return { status: 'current', observation: input.expected, work: measured };
      }
      const read = async (tx: CommandTransaction): Promise<S.IdentityScopeRevalidateResult> => {
        const row = await head(tx, input.key, measured);
        if (!row) return fail('summary_missing', measured);
        if (row.state !== 'ready' || row.active !== 0)
          return fail(row.active ? 'pending_claim' : 'source_unready', measured);
        if (
          row.capture_id !== input.expected.captureId ||
          BigInt(row.revision) !== input.expected.committedRevision ||
          !same(row.source, input.key.source)
        )
          return fail('source_unready', measured, 'stale');
        return { status: 'current', observation: observation(input.key, row), work: measured };
      };
      // The Source caller supplies its existing start/final native snapshot. No extra group/home probe.
      if (input.tx) return read(input.tx);
      return withReadTransaction(pool, read);
    },
    async repair(input) {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
        throw new RangeError('Repair limit must be 1..100');
      const measured = work();
      const row = await withReadTransaction(pool, (tx) => head(tx, input.key, measured));
      if (!row) return fail('summary_missing', measured);
      const allowance =
        input.allowance ??
        (row.maintenance_allowance ? { ...row.maintenance_allowance, reservationId: randomUUID() } : null) ??
        (row.capture.kind === 'library' ? { ...row.capture.allowance, reservationId: randomUUID() } : null);
      if (row.state === 'retiring') {
        if (!allowance) return fail('custody_missing', measured);
        const result = await retireScope({ key: input.key, allowance, deadline: input.deadline });
        for (const axis of ['rows', 'points', 'statements', 'bytes'] as const) measured[axis] += result.work[axis];
        return { status: 'pending', observation: null, work: measured };
      }
      if (row.active > 0) {
        const active = await withReadTransaction(
          pool,
          async (tx) =>
            (
              await query(
                tx,
                measured,
                `SELECT job_id,job_epoch,attempt FROM semantic.identity_scope_attempt
          WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND registration=$4 AND state='active'
          ORDER BY job_id,job_epoch LIMIT 1`,
                [...params(input.key), row.registration],
              )
            ).rows[0] as Attempt | undefined,
        );
        if (!active || !allowance) return fail('custody_missing', measured);
        const finished = await finishScope({
          key: input.key,
          job: { jobId: active.job_id, epoch: BigInt(active.job_epoch) },
          attempt: active.attempt,
          allowance,
          deadline: input.deadline,
        });
        for (const axis of ['rows', 'points', 'statements', 'bytes'] as const) measured[axis] += finished.work[axis];
        // One actual native expected page per step; no unbounded all-attempt loop.
        return { status: 'pending', observation: null, work: measured };
      }
      const result = await advance(input.key, input.deadline, measured, allowance ?? undefined);
      if (result.status === 'registered')
        return { status: 'repaired', observation: result.observation, work: measured };
      if (result.status === 'pending') return { status: 'pending', observation: null, work: measured };
      return result;
    },
    retire: retireScope,
  };
}

/** Retained fair repair shares the native maintenance queue; workflow arguments contain only a home. */
export async function registerIdentityScopedObservationWork({ pool, client, clock }: WorkContext): Promise<void> {
  const homePage = DBOS.registerStep(
    async () =>
      (
        await runCommand(pool, { partition: 0, clock }, async (tx) => {
          const row = (
            await tx.query<{ next_home: number }>(`SELECT next_home FROM semantic.identity_scope_repair_cursor
      WHERE partition_no=0 FOR UPDATE`)
          ).rows[0];
          if (!row) throw unavailable();
          const homes = Array.from({ length: 16 }, (_, i) => (row.next_home + i) % 4096);
          await tx.query(`UPDATE semantic.identity_scope_repair_cursor SET next_home=$1 WHERE partition_no=0`, [
            (row.next_home + 16) % 4096,
          ]);
          return { value: homes, events: [] };
        })
      ).value,
    { name: 'semantic.identityScopes.homes' },
  );
  const step = DBOS.registerStep(
    async (partition: number) => {
      const selected = await runCommand<S.IdentityScopeKey | null>(pool, { partition, clock }, async (tx) => {
        const cursor = (
          await tx.query<{ source_key: string; scope_id: string }>(
            `SELECT source_key,scope_id
        FROM semantic.identity_scope_repair_cursor WHERE partition_no=$1 FOR UPDATE`,
            [partition],
          )
        ).rows[0];
        if (!cursor) throw unavailable();
        const select = `SELECT source_key,scope_id,source FROM semantic.identity_scope_summary
        WHERE partition_no=$1 AND state IN ('capturing','enrolling','repair','retiring')`;
        let pending = await tx.query<{ source_key: string; scope_id: string; source: S.IdentityScopeSource }>(
          `${select} AND (source_key,scope_id)>($2,$3) ORDER BY source_key,scope_id LIMIT 1`,
          [partition, cursor.source_key, cursor.scope_id],
        );
        if (!pending.rows.length)
          pending = await tx.query(`${select} ORDER BY source_key,scope_id LIMIT 1`, [partition]);
        const row = pending.rows[0];
        if (!row) return { value: null, events: [] };
        await tx.query(
          `UPDATE semantic.identity_scope_repair_cursor SET source_key=$2,scope_id=$3 WHERE partition_no=$1`,
          [partition, row.source_key, row.scope_id],
        );
        return { value: { source: row.source, scopeId: row.scope_id }, events: [] };
      });
      // Release the cursor command before native capture/enrollment opens any other home.
      if (selected.value)
        await createIdentityScopedObservations(pool).repair({
          key: selected.value,
          limit: 1,
          deadline: Date.now() + 5000,
        });
    },
    { name: 'semantic.identityScopes.page', retriesAllowed: true, maxAttempts: 3 },
  );
  DBOS.registerWorkflow(
    async () => {
      for (const home of await homePage()) await step(home);
    },
    { name: 'semantic.identityScopes.repair' },
  );
  await client.applySchedules([
    {
      scheduleName: 'semantic.identityScopes.every-minute',
      workflowName: 'semantic.identityScopes.repair',
      schedule: '* * * * *',
      queueName: 'maintenance',
      cronTimezone: 'UTC',
      automaticBackfill: false,
    },
  ]);
}

/** Source-owned unsafe receiving, also used for exact closed-attempt cancellation reconciliation. */
export async function receiveScopePreparation(
  pool: Pool,
  ticket: IdentityPrearmTicketData,
  cancellation?: IdentityNativeReceipt,
): Promise<IdentityNativeReceipt> {
  if (ticket.scope.source.kind === 'library' && ticket.scope.source.identity.scope === 'public_output')
    throw new IdentityEpochStoreError(
      'identity_epoch_unavailable',
      'Public output preparation requires its original caller work frame via receiveIdentityScopePrearm',
    );
  const key = ticket.scope;
  const k = identityScopeAddress(key);
  const measured = work();
  if (cancellation) {
    // Exact terminal job + native cancellation record at the job home, released before Source custody.
    if (cancellation.partition !== identityJobPartition(ticket.locator.job)) throw unavailable();
    const terminal = await withReadTransaction(
      pool,
      async (tx) =>
        (
          await query(
            tx,
            measured,
            `SELECT 1 FROM semantic.identity_epoch_job j
      JOIN semantic.identity_epoch_admission_receipt r ON (r.partition_no,r.job_id,r.job_epoch)=(j.partition_no,j.job_id,j.epoch) AND r.stage='closed'
      JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id,c.epoch,c.position)=(r.partition_no,r.transaction_id,r.native_epoch,r.native_position) AND c.xmin=r.xmin
      JOIN core.partition p ON p.partition_no=j.partition_no AND p.epoch=c.epoch AND p.position>=c.position
      WHERE j.partition_no=$1 AND j.job_id=$2 AND j.epoch=$3 AND j.state IN ('cancelling','cancelled') AND c.transaction_id=$4 AND c.epoch=$5 AND c.position=$6
      AND p.write_state='active' AND p.moved_to IS NULL`,
            [
              cancellation.partition,
              ticket.locator.job.jobId,
              ticket.locator.job.epoch.toString(),
              cancellation.transactionId,
              cancellation.epoch,
              cancellation.position.toString(),
            ],
          )
        ).rowCount === 1,
    );
    if (!terminal) throw unavailable();
  }
  await runCommand(pool, { partition: k.partition }, async (tx) => {
    const row = await head(tx, key, measured, true);
    if (
      !row ||
      row.state === 'retired' ||
      row.registration !== ticket.registration ||
      row.capture_id !== ticket.captureId ||
      !(await proofCurrent(tx, key, row, measured, !!cancellation))
    )
      throw unavailable();
    const job = ticket.locator.job;
    const a = [...params(key), row.registration, job.jobId, job.epoch.toString()];
    const prior = (
      await query(
        tx,
        measured,
        `SELECT * FROM semantic.identity_scope_attempt WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND registration=$4 AND job_id=$5 AND job_epoch=$6 FOR UPDATE`,
        a,
      )
    ).rows[0];
    if (prior && !same(prior.attempt, ticket.attempt)) throw unavailable();
    if (!cancellation && prior && prior.state !== 'active') throw unavailable();
    const transition = cancellation ? prior?.state !== 'cancelled' : !prior;
    const disposition = cancellation ? 'cancelled' : 'unsafe';
    if (transition) {
      await query(
        tx,
        measured,
        `UPDATE semantic.identity_scope_summary SET active=active+$4,state=CASE WHEN state IN ('retired','retiring') THEN state ELSE 'repair' END,revision=revision+1 WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3`,
        [...params(key), cancellation ? (prior?.state === 'active' ? -1 : 0) : 1],
      );
      await query(
        tx,
        measured,
        `INSERT INTO semantic.identity_scope_attempt(partition_no,source_key,scope_id,registration,job_id,job_epoch,attempt,state,transaction_id,revision)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(partition_no,source_key,scope_id,registration,job_id,job_epoch)
        DO UPDATE SET state=excluded.state,transaction_id=excluded.transaction_id,revision=excluded.revision`,
        [
          ...a,
          json(ticket.attempt),
          cancellation ? 'cancelled' : 'active',
          currentCommand(tx).transactionId,
          (BigInt(row.revision) + 1n).toString(),
        ],
      );
    }
    await query(
      tx,
      measured,
      `INSERT INTO semantic.identity_scope_prearm_receipt
      (partition_no,source_key,scope_id,registration,job_id,job_epoch,directory_transaction,page_id,ordinal,disposition,transaction_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
      [
        ...a,
        ticket.locator.directory.transactionId,
        ticket.locator.pageId,
        ticket.locator.ordinal,
        disposition,
        currentCommand(tx).transactionId,
      ],
    );
    recordIdentityEpochNativeCommit(tx, cancellation ? 'identity-scope-cancellation' : 'identity-scope-preparation');
    return { value: null, events: [] };
  });
  // Duplicate deliveries resolve the original receipt, never manufacture a new summary transition.
  return withReadTransaction(pool, async (tx) => {
    const receipt = (
      await query(
        tx,
        measured,
        `SELECT c.partition_no,c.epoch,c.position::text,c.transaction_id FROM semantic.identity_scope_prearm_receipt r
      JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(r.partition_no,r.transaction_id) AND c.xmin=r.xmin
      JOIN core.partition p ON p.partition_no=c.partition_no AND p.epoch=c.epoch AND p.position>=c.position
      WHERE r.partition_no=$1 AND r.source_key=$2 AND r.scope_id=$3 AND r.registration=$4 AND r.job_id=$5 AND r.job_epoch=$6
      AND r.directory_transaction=$7 AND r.page_id=$8 AND r.ordinal=$9 AND r.disposition=$10
      AND c.purpose=$11 AND p.write_state='active' AND p.moved_to IS NULL`,
        [
          ...params(key),
          ticket.registration,
          ticket.locator.job.jobId,
          ticket.locator.job.epoch.toString(),
          ticket.locator.directory.transactionId,
          ticket.locator.pageId,
          ticket.locator.ordinal,
          cancellation ? 'cancelled' : 'unsafe',
          cancellation ? 'identity-scope-cancellation' : 'identity-scope-preparation',
        ],
      )
    ).rows[0];
    if (!receipt) throw unavailable();
    return {
      partition: receipt.partition_no,
      epoch: receipt.epoch,
      position: BigInt(receipt.position),
      transactionId: receipt.transaction_id,
    };
  });
}

/** Source-local native obligation, called only after the terminal owner has checked
 * Library's current seal in this same command. Rechecking here prevents an unrelated
 * seal, a completed prefix, or a released receipt read from becoming a durable fence.
 * The returned component is usable only within this transaction until commit.
 */
export async function retainIdentityScopeConsumerFence(
  tx: CommandTransaction,
  ticket: IdentityPrearmTicketData,
  seal: LibraryScopeEffectSeal,
): Promise<IdentityNativeReceipt | null> {
  const resources = currentCommandResources(tx);
  const budget = currentIdentitySourceConsumerLibraryRemainder(resources.pool, resources.deadline);
  if (!budget) return null;
  claimIdentitySourceLibraryCall(resources.pool, 'exhaustedPageRechecks');
  if (isPrepaidIdentitySourceConsumerMaintenance(resources.pool))
    return retainCurrentIdentityScopeConsumerFence(tx, ticket, seal);
  return instrumentNativeCollectionWork(resources.pool, budget,
    (sql, values) => libraryIdentityFootprint(sql, values, budget) ?? scopeConsumerFootprint(sql, values), () =>
    retainCurrentIdentityScopeConsumerFence(tx, ticket, seal),
  );
}

async function retainCurrentIdentityScopeConsumerFence(
  tx: CommandTransaction,
  ticket: IdentityPrearmTicketData,
  seal: LibraryScopeEffectSeal,
): Promise<IdentityNativeReceipt | null> {
  const command = currentCommand(tx);
  const resources = currentCommandResources(tx);
  const prepaid = isPrepaidIdentitySourceConsumerMaintenance(resources.pool);
  const token = prepaid ? currentIdentitySourceConsumerMaintenance(resources.pool, resources.deadline) : null;
  // Source body statements are disjoint from Library's two exact verifier
  // invocations. Debit each original bind/projection before its corresponding IO.
  const reserve = (sql: string, values: readonly unknown[]) => {
    if (!prepaid) return;
    const cost = scopeConsumerFootprint(sql, values);
    if (!token || !cost || !reserveIdentitySourceConsumerNativeWork(resources.pool, token, {
      rows: cost.nativeRows, points: cost.nativePoints, statements: cost.statements,
      bytes: cost.bytes, engineRequests: 0,
    }, cost)) throw new IdentitySourceOriginalUnavailable('identity-source-fence-native-body-declaration-unavailable');
  };
  if (command.basis !== null || Date.now() >= currentCommandResources(tx).deadline) return null;
  const source = ticket.scope.source;
  // The public planner and public-output custody are independent owner branches.
  if (source.kind !== 'library' || source.identity.scope === 'public_output') return null;
  const address = identityScopeAddress(ticket.scope);
  if (command.partition !== address.partition) return null;
  const key: LibraryScopeEffectsKey = {
    job: ticket.locator.job,
    sourceIdentity: source.identity,
    scope: ticket.scope.scopeId,
  };
  if (!seal?.key || !same(seal.key, key) || !(await verifyLibraryScopeEffectsSeal(tx, key, seal))) return null;
  reserve(consumerCurrent.sql, scopeConsumerValues(ticket));
  const current = (
    await tx.query<{ revision: string; version: string; source_generation: string; seal: object }>(
      consumerCurrent.sql,
      scopeConsumerValues(ticket),
    )
  ).rows[0];
  if (!current || current.source_generation !== source.identity.generation || !same(current.seal, seal)) return null;
  const sealDigest = digest(seal);
  const receiptValues = [
    ...params(ticket.scope),
    ticket.registration,
    ticket.locator.job.jobId,
    ticket.locator.job.epoch.toString(),
    sealDigest,
    command.transactionId,
  ];
  reserve(consumerReceipt.sql, receiptValues);
  const prior = (
    await tx.query<{
      epoch: number;
      position: string;
      transaction_id: string;
      capture_id: string;
      attempt: object;
      source_generation: string;
      completion_version: string;
      seal_digest: string;
    }>(consumerReceipt.sql, receiptValues)
  ).rows[0];
  if (prior) {
    if (
      prior.capture_id !== ticket.captureId ||
      !same(prior.attempt, ticket.attempt) ||
      prior.source_generation !== current.source_generation ||
      prior.completion_version !== current.version
    )
      return null;
    return Object.freeze({
      partition: address.partition,
      epoch: prior.epoch,
      position: BigInt(prior.position),
      transactionId: prior.transaction_id,
    });
  }
  // Check the natural key before any write; a different seal cannot replace an
  // immutable retained obligation. The summary lock also serializes all writers.
  reserve(consumerConflict.sql, receiptValues.slice(0, 6));
  const conflict = await tx.query(consumerConflict.sql, receiptValues.slice(0, 6));
  if (conflict.rows.length) return null;
  // This existing native helper dispatches precisely read/insert/read on this
  // transaction; reserve all three original operands before entering it.
  reserve(consumerNative.sql, [command.partition, command.transactionId]);
  reserve(insertNativeCommit.sql, [command.partition, command.transactionId, 'identity-scope-finish']);
  reserve(consumerNative.sql, [command.partition, command.transactionId]);
  const receipt = await writeIdentityScopeConsumerNativeCommit(tx);
  const insertValues = [
    ...params(ticket.scope),
    ticket.registration,
    ticket.captureId,
    ticket.locator.job.jobId,
    ticket.locator.job.epoch.toString(),
    json(ticket.attempt),
    current.source_generation,
    current.version,
    sealDigest,
    receipt.epoch,
    receipt.position.toString(),
    receipt.transactionId,
  ];
  reserve(consumerInsert.sql, insertValues);
  await tx.query(consumerInsert.sql, insertValues);
  return receipt;
}

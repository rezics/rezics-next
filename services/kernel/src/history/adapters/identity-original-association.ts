import { memoizedValue } from '../../memoized.ts';
import canonicalize from 'canonicalize';
import { Value } from 'typebox/value';
import type { Pool } from 'pg';
import {
  currentCommand,
  currentCommandResources,
  noEffect,
  runCommand,
  withSingleCommandAttempt,
  type CommandTransaction,
} from '../../command/command.ts';
import { ACCESS_EVENTS } from '../../access/events.ts';
import type { AgentVerificationReversal } from '../../access/agent-verification.ts';
import type { Effect } from '../../events/effects.ts';
import type { CloudEvent, Envelope } from '../../events/log.ts';
import type { WorkClient } from '../../work/client.ts';
import { partitionOf, routeOf } from '../../route/route.ts';
import {
  IdentityOriginalUnavailable,
  originalControlWork,
  originalWorkVector,
  ORIGINAL_NATIVE_CONTROL,
  sumOriginalControl,
  IDENTITY_ORIGINAL_DEADLINE_MS,
} from '../../access/identity-original-admission.ts';
import {
  type AccountReference,
  type HistoryHandle,
  type HistoryPool,
  type HistoryWorkClient,
  IDENTITY_FX_EFFECT,
  encodeLocator,
  validateScope,
} from '../contract/index.ts';
import { nativePool, nativeWorkClient } from './handles.ts';

export const IDENTITY_FX_EVENT = 'com.rezics.access.agent-verification.reversing.v1';
export const IDENTITY_FX_CHILD_DECLARATION_MISSING = 'identity-fx-original-child-declaration-unavailable';

// Closed local graph. Source: exact intent/inventory/obligation/receipt/outbox, role cut (65 is
// the overflow sentinel), one prior original, one INSERT. No Source/Library/SDK price is included.
export function IDENTITY_FX_SOURCE_CONTROL() {
  return memoizedValue(IDENTITY_FX_SOURCE_CONTROL, () =>
    Object.freeze({
      command: ORIGINAL_NATIVE_CONTROL,
      source: originalControlWork(7, 7, 1, 16384, 7),
      roles: originalControlWork(65, 1, 1, 8192, 1),
      barriers: originalControlWork(64, 64, 1, 16384, 64),
      previous: originalControlWork(1, 1, 1, 32768, 1),
      insert: originalControlWork(1, 1, 1, 32768),
    }),
  );
}
export function IDENTITY_FX_SOURCE_ADMISSION() {
  return memoizedValue(IDENTITY_FX_SOURCE_ADMISSION, () =>
    sumOriginalControl(...Object.values(IDENTITY_FX_SOURCE_CONTROL())),
  );
}
export function IDENTITY_FX_RECEIVING_CONTROL() {
  return memoizedValue(IDENTITY_FX_RECEIVING_CONTROL, () =>
    Object.freeze({
      command: ORIGINAL_NATIVE_CONTROL,
      home: originalControlWork(1, 1, 1, 128, 1),
      domain: originalControlWork(1, 1, 1, 128, 1),
      previous: originalControlWork(1, 1, 1, 32768, 1),
      insert: originalControlWork(1, 1, 1, 32768),
    }),
  );
}
export function IDENTITY_FX_RECEIVING_ADMISSION() {
  return memoizedValue(IDENTITY_FX_RECEIVING_ADMISSION, () =>
    sumOriginalControl(...Object.values(IDENTITY_FX_RECEIVING_CONTROL())),
  );
}
export function IDENTITY_FX_REPLAY_CONTROL() {
  return memoizedValue(IDENTITY_FX_REPLAY_CONTROL, () =>
    sumOriginalControl(
      ORIGINAL_NATIVE_CONTROL,
      originalControlWork(1, 1, 1, 32768, 1),
      originalControlWork(1, 1, 1, 0),
    ),
  );
}
// Projection columns outside the bounded JSON: source/replay UUID(36)+deadline(16)
// twice; receiving UUID(36)+epoch(10)+generation(19)+deadline(16); replay RETURNING UUID(36).
export function IDENTITY_FX_ENCODED_COLUMNS() {
  return memoizedValue(IDENTITY_FX_ENCODED_COLUMNS, () => originalControlWork(0, 0, 0, 2 * 52 + 81 + 36));
}
// This is a local admission cap, not a change to DBOS retries or a whole-wrapper price.
const FX_LOCAL_ATTEMPTS = 10;
export function IDENTITY_FX_LOCAL_ATTEMPT() {
  return memoizedValue(IDENTITY_FX_LOCAL_ATTEMPT, () =>
    sumOriginalControl(
      IDENTITY_FX_SOURCE_ADMISSION(),
      IDENTITY_FX_RECEIVING_ADMISSION(),
      IDENTITY_FX_REPLAY_CONTROL(),
      IDENTITY_FX_ENCODED_COLUMNS(),
    ),
  );
}
export function IDENTITY_FX_LOCAL_ALLOWANCE() {
  return memoizedValue(IDENTITY_FX_LOCAL_ALLOWANCE, () =>
    sumOriginalControl(...Array.from({ length: FX_LOCAL_ATTEMPTS }, () => IDENTITY_FX_LOCAL_ATTEMPT())),
  );
}

type Route = Readonly<{ pool: Pool; client: WorkClient }>;
const routes = new WeakMap<Effect, Route>();
/** Bound by actual Work composition; public Effect and registration signatures stay unchanged. */
export function bindIdentityOriginalEffect<E extends HistoryHandle>(
  value: E,
  deps: Readonly<{ pool: HistoryPool; client: HistoryWorkClient }>,
): E {
  const effect = value as unknown as Effect;
  if (
    effect.name !== IDENTITY_FX_EFFECT ||
    effect.types.length !== 1 ||
    effect.types[0] !== IDENTITY_FX_EVENT ||
    !deps.pool ||
    !deps.client ||
    routes.has(effect)
  )
    throw new TypeError('Invalid identity original effect binding');
  routes.set(effect, Object.freeze({ pool: nativePool(deps.pool), client: nativeWorkClient(deps.client) }));
  return value;
}

export function isIdentityOriginalEffect(effect: { name: string; types: string[] }, event: CloudEvent): boolean {
  return effect.name === IDENTITY_FX_EFFECT && event.type === IDENTITY_FX_EVENT;
}

function route(effect: Effect, pool: Pool): Route {
  const deps = routes.get(effect);
  if (!deps || deps.pool !== pool) throw new IdentityOriginalUnavailable('identity-fx-original-producer-unavailable');
  return deps;
}

export function validateIdentityOriginalEvent(envelope: Envelope, eventSeq: number): AgentVerificationReversal {
  const event = envelope.events[eventSeq];
  if (
    !event ||
    event.type !== IDENTITY_FX_EVENT ||
    !Value.Check(ACCESS_EVENTS()[IDENTITY_FX_EVENT], event.data) ||
    !Number.isSafeInteger(envelope.partition) ||
    envelope.partition < 0 ||
    envelope.partition > 4095 ||
    !Number.isSafeInteger(envelope.epoch) ||
    envelope.epoch < 1 ||
    envelope.epoch > 2147483647 ||
    typeof envelope.position !== 'bigint' ||
    envelope.position <= 0n ||
    envelope.position > 9223372036854775807n ||
    !Number.isSafeInteger(eventSeq) ||
    eventSeq < 0 ||
    eventSeq > 999 ||
    event.source !== `urn:rezics:log:${envelope.partition}.${envelope.epoch}` ||
    event.sequence !== envelope.position.toString().padStart(19, '0') ||
    Buffer.byteLength(JSON.stringify(event)) > 8192
  )
    throw new IdentityOriginalUnavailable('identity-fx-original-envelope-invalid');
  const decision = event.data as AgentVerificationReversal;
  const accountRoute = routeOf(decision.accountId);
  if (accountRoute === null || partitionOf(accountRoute) !== envelope.partition || event.subject !== decision.accountId)
    throw new IdentityOriginalUnavailable('identity-fx-original-envelope-invalid');
  return decision;
}

type SourceRow = {
  intent_digest: string;
  source_transaction_id: string;
  workflow_id: string;
  delivery_key: string;
  undo_job_id: string;
  undo_job_epoch: string;
  receiver_epoch: number;
  domain_generation: string;
  inventory_generation: string;
  obligation_generation: string;
};

/** Data validation only. Original authority still requires the native producer and physical
 * joins below. Keep PostgreSQL bigint generations exact rather than converting to Number. */
export function identityFxSourceIncarnation(source: SourceRow): Readonly<SourceRow> {
  const generation = (value: string) =>
    typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
  if (
    !generation(source.domain_generation) ||
    !generation(source.inventory_generation) ||
    !generation(source.obligation_generation) ||
    source.inventory_generation !== source.obligation_generation ||
    !Number.isSafeInteger(source.receiver_epoch) ||
    source.receiver_epoch < 1 ||
    source.receiver_epoch > 2147483647
  )
    throw new IdentityOriginalUnavailable('identity-fx-original-source-incarnation-unavailable');
  return Object.freeze({ ...source });
}
type Binding = Readonly<{
  partition: number;
  epoch: number;
  position: string;
  eventSeq: number;
  effect: string;
  event: CloudEvent;
  workflowId: string;
  source: SourceRow;
  accounts: readonly AccountReference[];
  barriers: readonly Readonly<{ accountId: string; version: number | null; at: string | null }>[];
}>;
type Original = Readonly<{ originalId: string; deadline: number; binding: Binding }>;
const originals = new WeakMap<Original, Route>();

function native<T>(deps: Route, partition: number, deadline: number, body: (tx: CommandTransaction) => Promise<T>) {
  return withSingleCommandAttempt(
    async () =>
      (
        await runCommand(deps.pool, { partition, deadline }, async (tx) => {
          if (currentCommandResources(tx).pool !== deps.pool) throw new TypeError('Foreign identity original command');
          return noEffect(await body(tx));
        })
      ).value,
  );
}

/** Called before the identity route's consumer admission or SDK enqueue. This is an independent
 * source-home native command, and its checkout is released before home-zero receiving. */
export async function associateIdentityFxOriginal(
  effect: Effect,
  pool: Pool,
  envelope: Envelope,
  eventSeq: number,
  workflowId: string,
): Promise<void> {
  const deps = route(effect, pool);
  const decision = validateIdentityOriginalEvent(envelope, eventSeq);
  const event = envelope.events[eventSeq]!;
  // The actual caller supplies the real wrapper ID; it is compared as data, never parsed as authority.
  if (
    workflowId !== `fx:${envelope.epoch}:${envelope.partition}:${envelope.position}:${eventSeq}:${effect.name}` ||
    Buffer.byteLength(workflowId) > 256
  )
    throw new IdentityOriginalUnavailable('identity-fx-original-workflow-mismatch');
  // Receiving spends the original's prepaid local prefix, not another Source frame.
  const sourceBudget = originalWorkVector(IDENTITY_FX_LOCAL_ALLOWANCE());
  const attemptBudget = originalWorkVector(IDENTITY_FX_LOCAL_ATTEMPT());
  const receivingBudget = originalWorkVector(IDENTITY_FX_RECEIVING_ADMISSION());
  const deadline = Date.now() + IDENTITY_ORIGINAL_DEADLINE_MS;
  // A replay debits its complete repeated source/receiving/control path in a separate
  // committed command. Failure of any later native transaction cannot refund it.
  const prepaid = await native(deps, envelope.partition, deadline, async (tx) => {
    const previous = (
      await tx.query<{ original_id: string; deadline: string; binding: Binding }>(
        `SELECT original_id,deadline::text,binding FROM core.identity_fx_original
       WHERE partition_no=$1 AND epoch=$2 AND position=$3 AND event_seq=$4 AND effect=$5 FOR UPDATE`,
        [envelope.partition, envelope.epoch, envelope.position.toString(), eventSeq, effect.name],
      )
    ).rows[0];
    if (!previous) return null;
    if (previous.binding.workflowId !== workflowId || canonicalize(previous.binding.event) !== canonicalize(event))
      throw new IdentityOriginalUnavailable('identity-fx-original-replay-mismatch');
    if (Number(previous.deadline) <= Date.now()) throw new IdentityOriginalUnavailable('identity-fx-original-expired');
    const updated = await tx.query(
      `UPDATE core.identity_fx_original SET spent=ARRAY[
        spent[1]+$2::bigint,spent[2]+$3::bigint,spent[3]+$4::bigint,spent[4]+$5::bigint,
        spent[5]+$6::bigint,spent[6]+$7::bigint,spent[7]+$8::bigint,spent[8]+$9::bigint]
       WHERE original_id=$1
         AND spent[1]+$2<=allowance[1] AND spent[2]+$3<=allowance[2]
         AND spent[3]+$4<=allowance[3] AND spent[4]+$5<=allowance[4]
         AND spent[5]+$6<=allowance[5] AND spent[6]+$7<=allowance[6]
         AND spent[7]+$8<=allowance[7] AND spent[8]+$9<=allowance[8] RETURNING original_id`,
      [previous.original_id, ...attemptBudget],
    );
    if (updated.rows.length !== 1)
      throw new IdentityOriginalUnavailable('identity-fx-original-local-control-exhausted');
    return { originalId: previous.original_id, deadline: Number(previous.deadline) };
  });
  const original = await native(
    deps,
    envelope.partition,
    prepaid?.deadline ?? deadline,
    async (tx): Promise<Original> => {
      // All joined native rows have the same source partition and full point keys. The real
      // physical receipt and outbox data, not caller payload or workflow naming, authenticate it.
      const observedSource = (
        await tx.query<SourceRow>(
          `SELECT i.intent_digest,i.source_transaction_id,i.workflow_id,i.delivery_key,i.undo_job_id,
         i.undo_job_epoch::text,n.receiver_epoch,n.domain_generation::text,
         n.generation::text AS inventory_generation,s.generation::text AS obligation_generation
       FROM access.agent_identity_intent i
       JOIN core.agent_identity_inventory n ON n.partition_no=i.source_partition AND n.source_route=i.route
         AND n.source_account_id=i.account_id AND n.source_direction=i.direction AND n.source_receipt_id=i.receipt_id
       JOIN core.agent_identity_sdk_obligation s ON s.partition_no=n.partition_no AND s.source_route=n.source_route
         AND s.source_account_id=n.source_account_id AND s.source_direction=n.source_direction AND s.source_receipt_id=n.source_receipt_id
       JOIN core.receipt r ON r.partition_no=i.source_partition AND r.principal_kind=n.native_principal_kind
         AND r.principal_id=n.native_principal_id AND r.command_kind=n.native_command_kind AND r.idempotency_key=n.native_receipt_key
       JOIN core.outbox o ON o.partition_no=i.source_partition AND o.position=i.source_position AND o.event_seq=$6
       JOIN core.partition p ON p.partition_no=i.source_partition AND p.write_state='active' AND p.epoch=i.source_epoch
       CROSS JOIN core.history_family_domain d
       WHERE i.route=$1 AND i.account_id=$2 AND i.direction='account-agent.unverify' AND i.receipt_id=$3
         AND NOT i.minimized AND i.source_partition=$4 AND i.source_epoch=$5 AND i.source_position=$7
         AND octet_length(i.workflow_id)<=256 AND octet_length(i.delivery_key)<=256
         AND i.undo_job_id IS NOT NULL AND i.undo_job_epoch>0
         AND r.epoch=$5 AND r.position=$7 AND r.transaction_id=i.source_transaction_id
         AND r.payload_state='present' AND r.response=$8::jsonb
         AND o.epoch=$5 AND o.type=$9 AND o.id=$10 AND o.subject=$2 AND o.data=$8::jsonb AND o.payload_state='present'
         AND n.source_digest=i.intent_digest AND n.source_epoch=i.source_epoch AND n.source_position=i.source_position
         AND n.source_transaction_id=i.source_transaction_id AND n.state='sealed' AND n.native_writer_state='closed'
         AND n.native_command_kind=i.native_command_kind AND n.native_receipt_key=i.native_receipt_key
         AND n.receiver_epoch=p.epoch AND d.singleton AND n.domain_generation=d.generation
         AND s.workflow_id=i.workflow_id AND s.delivery_key=i.delivery_key AND s.generation=n.generation
         AND s.handoff_partition=$4 AND s.handoff_epoch=$5 AND s.handoff_position=$7
         AND s.handoff_transaction_id=i.source_transaction_id AND s.handoff_event_type=$9
       FOR SHARE OF i,n,s,r,o,p,d`,
          [
            routeOf(decision.accountId),
            decision.accountId,
            decision.receiptId,
            envelope.partition,
            envelope.epoch,
            eventSeq,
            envelope.position.toString(),
            JSON.stringify(decision),
            IDENTITY_FX_EVENT,
            event.id,
          ],
        )
      ).rows[0];
      if (!observedSource) throw new IdentityOriginalUnavailable('identity-fx-original-source-receipt-job-unavailable');
      const source = identityFxSourceIncarnation(observedSource);
      const locator = Buffer.from(
        encodeLocator({
          artifactType: 'outbox-event/v1',
          partitionNo: envelope.partition,
          position: envelope.position,
          eventSeq,
        }),
      );
      const roles = await tx.query<{ account_route: number; account_id: string; roles: number }>(
        `SELECT account_route,account_id,roles FROM core.history_locator
       WHERE partition_no=$1 AND artifact_type='outbox-event/v1' AND locator=$2
       ORDER BY account_route,account_id LIMIT 65 FOR SHARE`,
        [envelope.partition, locator],
      );
      const accounts = roles.rows.map((r) => ({
        accountRoute: r.account_route,
        accountId: r.account_id,
        roles: r.roles,
      }));
      validateScope('outbox-event/v1', { artifactType: 'outbox-event/v1', accounts });
      if (accounts.length < 1 || accounts.length > 64 || Buffer.byteLength(JSON.stringify(accounts)) > 8192)
        throw new IdentityOriginalUnavailable('identity-fx-original-role-union-unavailable');
      // Roles live at the event home; erasure rows live at their own account homes. Read
      // their bounded full keys separately in this snapshot, never join across partitions.
      // validateScope and the overflow check precede construction: at most 64 keys/128 parameters.
      const barrierKeys = accounts.map((_, index) => `($${index * 2 + 1}::integer,$${index * 2 + 2}::uuid)`).join(',');
      const barrierRows = await tx.query<{ route: number; account_id: string; version: number; at: string }>(
        `SELECT route,account_id,version,at::text FROM access.erasure
       WHERE (route,account_id) IN (${barrierKeys}) ORDER BY route,account_id FOR SHARE`,
        accounts.flatMap((account) => [account.accountRoute, account.accountId]),
      );
      const byAccount = new Map(barrierRows.rows.map((row) => [row.account_id, row]));
      const barriers = accounts.map((account) => {
        const row = byAccount.get(account.accountId);
        if (
          row &&
          (row.route !== account.accountRoute ||
            !Number.isSafeInteger(row.version) ||
            row.version < 1 ||
            typeof row.at !== 'string' ||
            Buffer.byteLength(row.at) > 128)
        )
          throw new IdentityOriginalUnavailable('identity-fx-original-barrier-unavailable');
        return Object.freeze({ accountId: account.accountId, version: row?.version ?? null, at: row?.at ?? null });
      });
      const binding: Binding = Object.freeze({
        partition: envelope.partition,
        epoch: envelope.epoch,
        position: envelope.position.toString(),
        eventSeq,
        effect: effect.name,
        event: structuredClone(event),
        workflowId,
        source,
        accounts,
        barriers,
      });
      if (Buffer.byteLength(JSON.stringify(binding)) > 32768)
        throw new IdentityOriginalUnavailable('identity-fx-original-binding-too-large');
      const previous = (
        await tx.query<{ original_id: string; deadline: string; binding: Binding }>(
          `SELECT original_id,deadline::text,binding FROM core.identity_fx_original
       WHERE partition_no=$1 AND epoch=$2 AND position=$3 AND event_seq=$4 AND effect=$5 FOR UPDATE`,
          [envelope.partition, envelope.epoch, envelope.position.toString(), eventSeq, effect.name],
        )
      ).rows[0];
      if (previous) {
        if (!prepaid || prepaid.originalId !== previous.original_id)
          throw new IdentityOriginalUnavailable('identity-fx-original-precharge-required');
        if (canonicalize(previous.binding) !== canonicalize(binding))
          throw new IdentityOriginalUnavailable('identity-fx-original-replay-mismatch');
        if (Number(previous.deadline) <= Date.now())
          throw new IdentityOriginalUnavailable('identity-fx-original-expired');
        return Object.freeze({
          originalId: previous.original_id,
          deadline: Number(previous.deadline),
          binding: previous.binding,
        });
      }
      const originalId = currentCommand(tx).transactionId;
      await tx.query(
        `INSERT INTO core.identity_fx_original(original_id,partition_no,epoch,position,event_seq,effect,workflow_id,
        binding,deadline,allowance,spent) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          originalId,
          envelope.partition,
          envelope.epoch,
          envelope.position.toString(),
          eventSeq,
          effect.name,
          workflowId,
          JSON.stringify(binding),
          deadline,
          sourceBudget,
          attemptBudget,
        ],
      );
      return Object.freeze({ originalId, deadline, binding });
    },
  );
  originals.set(original, deps);
  try {
    await native(deps, 0, original.deadline, async (tx) => {
      if (originals.get(original) !== deps || Date.now() >= original.deadline)
        throw new IdentityOriginalUnavailable('identity-fx-original-transfer-unavailable');
      const home = (
        await tx.query<{ epoch: number }>(
          "SELECT epoch FROM core.partition WHERE partition_no=0 AND write_state='active' FOR SHARE",
        )
      ).rows[0];
      const domain = (
        await tx.query<{ generation: string }>(
          'SELECT generation::text FROM core.history_family_domain WHERE singleton FOR SHARE',
        )
      ).rows[0];
      if (!home || !domain) throw new IdentityOriginalUnavailable('identity-fx-original-receiving-home-unavailable');
      if (domain.generation !== original.binding.source.domain_generation)
        throw new IdentityOriginalUnavailable('identity-fx-original-receiving-incarnation-changed');
      const previous = (
        await tx.query<{
          original_id: string;
          binding: Binding;
          receiver_epoch: number;
          receiver_generation: string;
          deadline: string;
        }>(
          `SELECT original_id,binding,receiver_epoch,receiver_generation::text,deadline::text
         FROM core.identity_fx_receiving WHERE workflow_id=$1 FOR UPDATE`,
          [workflowId],
        )
      ).rows[0];
      if (previous) {
        if (
          previous.original_id !== original.originalId ||
          canonicalize(previous.binding) !== canonicalize(original.binding) ||
          previous.receiver_epoch !== home.epoch ||
          previous.receiver_generation !== domain.generation ||
          Number(previous.deadline) !== original.deadline
        )
          throw new IdentityOriginalUnavailable('identity-fx-original-receiving-incarnation-changed');
        return;
      }
      await tx.query(
        `INSERT INTO core.identity_fx_receiving(workflow_id,original_id,binding,receiver_epoch,receiver_generation,
          deadline,allowance,spent) VALUES($1,$2,$3,$4,$5,$6,$7,$7)`,
        [
          workflowId,
          original.originalId,
          JSON.stringify(original.binding),
          home.epoch,
          domain.generation,
          original.deadline,
          receivingBudget,
        ],
      );
    });
  } finally {
    originals.delete(original);
  }
}

/** The installed child/SDK interfaces do not declare a complete wrapper allocation or physical
 * receiving operation. Keep exactly that dispatch pending after independent association. */
export function requireIdentityFxOriginalDispatch(effect: Effect, pool: Pool): never {
  route(effect, pool);
  throw new IdentityOriginalUnavailable(IDENTITY_FX_CHILD_DECLARATION_MISSING);
}

import type { AuthErasureBarrier, AuthErasureSource, AuthErasureProofPorts } from '@rezics/auth-contract';
import type { Pool, PoolClient } from 'pg';
import type {
  AuthReceivingBinding,
  AuthReceivingClosurePorts,
  AuthReceivingClosureProducer,
  CurrentAuthReceivingClosure,
} from '@rezics/auth-contract';
import { discardConnection, withConnection } from '../database/pool.ts';
import { deadlineClient, within } from './deadline.ts';
export type { CurrentAuthReceivingClosure } from '@rezics/auth-contract';
import { routeOf } from '../route/route.ts';
import proofRead from './shared-history-auth.sql';

export class AuthHistoryProofDenied extends Error {
  readonly status = 403;
  constructor() {
    super('Auth history proof denied');
  }
}
const deny = () => new AuthHistoryProofDenied();
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
function shape(value: AuthErasureBarrier | AuthErasureSource, source: boolean) {
  const keys = source ? 'accountId,at,continuationId,receiptId,version' : 'accountId,at,version';
  if (
    !value ||
    Object.keys(value).sort().join(',') !== keys ||
    !uuid(value.accountId) ||
    routeOf(value.accountId) === null ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    typeof value.at !== 'string' ||
    value.at.length > 64 ||
    !Number.isFinite(Date.parse(value.at))
  )
    throw deny();
  if (source && (!uuid((value as AuthErasureSource).continuationId) || !uuid((value as AuthErasureSource).receiptId)))
    throw deny();
}
/** Anchored account-home read. No Auth database handle or maintenance capability crosses this seam. */
async function barrier(client: Pool | PoolClient, accountId: string): Promise<AuthErasureBarrier | null> {
  if (!uuid(accountId)) return null;
  const route = routeOf(accountId);
  if (route === null) return null;
  const result = await client.query<AuthErasureBarrier>(
    `SELECT e.account_id::text AS "accountId",e.version,e.at::text AS at
     FROM access.erasure e WHERE e.route=$1 AND e.account_id=$2
     AND EXISTS (SELECT 1 FROM access.account a WHERE a.route=$1 AND a.account_id=$2
                 AND a.state='deleted' AND a.authn_fenced)`,
    [route, accountId],
  );
  return result.rows[0] ?? null;
}
async function source(
  client: Pool | PoolClient,
  input: { accountId: string; receiptId: string },
): Promise<AuthErasureSource | null> {
  if (!uuid(input.receiptId)) return null;
  const root = await barrier(client, input.accountId);
  if (!root) return null;
  const result = await client.query<{ continuationId: string; receiptId: string }>(
    `SELECT continuation_id::text AS "continuationId",barrier_receipt_id::text AS "receiptId"
     FROM access.committed_continuation c WHERE route=$1 AND account_id=$2 AND barrier_receipt_id=$3
     AND allowlist @> '[{"step":"erase-auth-owner"}]'::jsonb
     AND allowlist @> jsonb_build_array(jsonb_build_object('step','erase-auth-owner','target',$2::text))
     AND EXISTS (SELECT 1 FROM access.committed_continuation_completion d
       WHERE d.route=c.route AND d.continuation_id=c.continuation_id
       AND d.step='erase-auth-owner' AND d.target=$2::text)`,
    [routeOf(input.accountId), input.accountId, input.receiptId],
  );
  const row = result.rows[0];
  return row ? { ...root, ...row } : null;
}
/** Possession of this fixed private binding is the Auth service capability. No principal/participant/scope is accepted. */
export function createAuthHistoryProofBindings(
  pool: Pool,
  producer: () => AuthReceivingClosureProducer | undefined = () => undefined,
): Required<AuthErasureProofPorts> & AuthReceivingClosurePorts {
  async function record(value: AuthErasureBarrier | AuthErasureSource, native: boolean): Promise<void> {
    shape(value, native);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Permanent erasure is immutable; account lock orders the proof with home cleanup.
      await client.query('SELECT account_id FROM access.account WHERE route=$1 AND account_id=$2 FOR UPDATE', [
        routeOf(value.accountId),
        value.accountId,
      ]);
      // Even a lost-reply redrive is anchored to the permanent committed
      // erasure and terminal account, never solely to a previously stored proof.
      const root = await barrier(client, value.accountId);
      if (!root || root.version !== value.version || root.at !== value.at) throw deny();
      const previous = (
        await client.query<{ version: number; at: string; continuation_id: string | null; receipt_id: string | null }>(
          'SELECT version,at::text,continuation_id,receipt_id FROM access.auth_history_proof WHERE route=$1 AND account_id=$2 AND phase=$3',
          [routeOf(value.accountId), value.accountId, native ? 'native-consumed' : 'copies-erased'],
        )
      ).rows[0];
      if (previous) {
        const proof = native ? (value as AuthErasureSource) : null;
        if (
          previous.version !== value.version ||
          previous.at !== value.at ||
          previous.continuation_id !== (proof?.continuationId ?? null) ||
          previous.receipt_id !== (proof?.receiptId ?? null)
        )
          throw deny();
        await client.query('COMMIT');
        return;
      }
      const expected = native
        ? await source(client, value as AuthErasureSource)
        : await barrier(client, value.accountId);
      if (
        !expected ||
        expected.version !== value.version ||
        expected.at !== value.at ||
        (native && (expected as AuthErasureSource).continuationId !== (value as AuthErasureSource).continuationId)
      )
        throw deny();
      if (!native) {
        const consumed = await client.query(
          `SELECT 1 FROM access.auth_history_proof WHERE route=$1 AND account_id=$2
           AND phase='native-consumed' AND version=$3 AND at=$4::timestamptz`,
          [routeOf(value.accountId), value.accountId, value.version, value.at],
        );
        if (!consumed.rowCount) throw deny();
      }
      const phase = native ? 'native-consumed' : 'copies-erased';
      const proof = native ? (value as AuthErasureSource) : null;
      await client.query(
        `INSERT INTO access.auth_history_proof(route,account_id,phase,version,at,continuation_id,receipt_id)
         VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [
          routeOf(value.accountId),
          value.accountId,
          phase,
          value.version,
          value.at,
          proof?.continuationId ?? null,
          proof?.receiptId ?? null,
        ],
      );
      const stored = (
        await client.query<{ version: number; at: string; continuation_id: string | null; receipt_id: string | null }>(
          `SELECT version,at::text,continuation_id,receipt_id FROM access.auth_history_proof
         WHERE route=$1 AND account_id=$2 AND phase=$3`,
          [routeOf(value.accountId), value.accountId, phase],
        )
      ).rows[0];
      if (
        !stored ||
        stored.version !== value.version ||
        stored.at !== value.at ||
        stored.continuation_id !== (proof?.continuationId ?? null) ||
        stored.receipt_id !== (proof?.receiptId ?? null)
      )
        throw deny();
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return {
    ...createReceivingBindings(pool, producer),
    readAuthErasureBarrier: (id) => barrier(pool, id),
    readAuthErasureSource: (input) => source(pool, input),
    recordAuthNativeConsumption: (input) => record(input, true),
    recordAuthHistoryCompletion: (input) => record(input, false),
  };
}
/** Phase-specific Access reader. Early native consumption never implies copy completion. */
export async function readAuthNativeConsumption(
  pool: Pool | PoolClient,
  expected: AuthErasureSource,
): Promise<boolean> {
  shape(expected, true);
  return (
    (await proofRead.run(pool, {
      route: routeOf(expected.accountId)!,
      account_id: expected.accountId,
      phase: 'native-consumed',
      version: expected.version,
      at: expected.at,
      continuation_id: expected.continuationId,
      receipt_id: expected.receiptId,
    })) !== null
  );
}

/** Historical local-copy publication only. The stored tuple has no Auth database
 * identity, receiving incarnation or restore generation. Even in a cohome this
 * read cannot issue CurrentAuthReceivingClosure or authorize witness retirement.
 * Current receiving validation needs an independently owned binding whose
 * writer/restore fence remains held through the caller's destructive commit.
 * Kernel producer/minimizer closure is also a separate prerequisite.
 */
export async function readHistoricalAuthHistoryCompletion(pool: Pool, expected: AuthErasureBarrier): Promise<boolean> {
  shape(expected, false);
  return (
    (await proofRead.run(pool, {
      route: routeOf(expected.accountId)!,
      account_id: expected.accountId,
      phase: 'copies-erased',
      version: expected.version,
      at: expected.at,
      continuation_id: null,
      receipt_id: null,
    })) !== null
  );
}

/** Native guard identity names the protocol, not an installed physical owner. */
export const AUTH_RECEIVING_CLOSURE_NATIVE_GUARD = 'auth.receiving-closure/v1' as const;
const locator = Symbol('Auth current receiving closure locator');
type Receipt = {
  barrier: AuthErasureBarrier;
  binding: AuthReceivingBinding;
  nativeObligationId: string;
  closureReceiptId: string;
  continuationId: string;
  sourceReceiptId: string;
};
type Issued = CurrentAuthReceivingClosure & { [locator]: Receipt };
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const receivingBarrier = ({ accountId, version, at }: AuthErasureBarrier): AuthErasureBarrier => ({
  accountId,
  version,
  at,
});

async function receivingTransaction<T>(pool: Pool, deadline: number, work: (tx: PoolClient) => Promise<T>) {
  if (!Number.isSafeInteger(deadline)) throw deny();
  return within(deadline, () =>
    withConnection(pool, async (connection) => {
      const tx = deadlineClient(connection, deadline) as PoolClient;
      try {
        await tx.query('BEGIN');
        await tx.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)", [
          String(Math.max(1, deadline - Date.now())),
        ]);
        const result = await work(tx);
        if (Buffer.byteLength(JSON.stringify(result)) > 65536) throw deny();
        await tx.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollback) {
          discardConnection(connection, rollback as Error);
        }
        throw error;
      }
    }),
  );
}

/** Same-home continuity only. Locks are acquired Source, control, account/root,
 * obligation. Replacement takes the same Source/control locks; no Auth I/O here. */
async function receivingSource(tx: PoolClient, partition: number) {
  return (
    (
      await tx.query<{ generation: string; source_epoch: number; source_owner: string }>(
        `SELECT s.generation::text,s.source_epoch,s.source_owner FROM core.partition p
     JOIN access.auth_erasure_source s USING(partition_no)
     WHERE p.partition_no=$1 AND p.write_state='active' AND s.initialized
     AND octet_length(s.source_owner)<=256 AND p.epoch=s.source_epoch AND p.node=s.source_owner FOR SHARE OF p,s`,
        [partition],
      )
    ).rows[0] ?? null
  );
}
async function receivingRoot(tx: PoolClient, expected: AuthErasureBarrier): Promise<boolean> {
  const route = routeOf(expected.accountId)!;
  const rows = await tx.query(
    `SELECT 1 FROM access.account a JOIN access.erasure e USING(route,account_id)
     JOIN access.auth_erasure_obligation o USING(route,account_id)
     WHERE a.route=$1 AND a.account_id=$2 AND a.state='deleted' AND a.authn_fenced
     AND a.minimum_authn_epoch>=o.minimum_authn_epoch AND o.minimum_authn_epoch IS NOT NULL
     AND e.version=$3 AND e.at=$4::timestamptz AND o.version=e.version AND o.at=e.at
     FOR SHARE OF a,e,o`,
    [route, expected.accountId, expected.version, expected.at],
  );
  return rows.rowCount === 1;
}
async function receivingBinding(tx: PoolClient, partition: number): Promise<AuthReceivingBinding | null> {
  const row = (
    await tx.query<AuthReceivingBinding>(
      `SELECT partition_no AS partition,source_generation::text AS "sourceGeneration",
     source_epoch AS "sourceEpoch",source_owner AS "sourceOwner",revision::text AS "controlRevision",
     database_identity AS "databaseIdentity",receiving_incarnation AS "receivingIncarnation",
     restore_generation AS "restoreGeneration",owner_installation AS "ownerInstallation",writer_fence AS "writerFence"
     FROM access.auth_receiving_control WHERE partition_no=$1 AND state='active'
     AND (requested_restore IS NULL OR requested_restore=restore_generation) FOR SHARE`,
      [partition],
    )
  ).rows[0];
  return row && Buffer.byteLength(JSON.stringify(row)) <= 1024 ? row : null;
}
async function currentReceipt(tx: PoolClient, expected: AuthErasureBarrier): Promise<Receipt | null> {
  const row = (
    await tx.query<{ receipt: Omit<Receipt, 'barrier'> | null }>(
      'SELECT access.lock_current_auth_receiving_closure($1,$2,$3,$4) AS receipt',
      [routeOf(expected.accountId), expected.accountId, expected.version, expected.at],
    )
  ).rows[0]?.receipt;
  const receipt = row ? { ...row, barrier: receivingBarrier(expected) } : null;
  return receipt && Buffer.byteLength(JSON.stringify(receipt)) <= 1024 ? receipt : null;
}
function createReceivingBindings(
  pool: Pool,
  producer: () => AuthReceivingClosureProducer | undefined,
): AuthReceivingClosurePorts {
  const ports: AuthReceivingClosurePorts = {
    async readAuthReceivingControl({ partition, restoreGeneration, deadline }) {
      if (
        !Number.isInteger(partition) ||
        partition < 0 ||
        partition >= 4096 ||
        typeof restoreGeneration !== 'string' ||
        Buffer.byteLength(restoreGeneration) > 1024
      )
        throw deny();
      return receivingTransaction(pool, deadline, async (tx) => {
        const source = await receivingSource(tx, partition);
        if (!source) return null;
        const binding = await receivingBinding(tx, partition);
        return binding &&
          binding.sourceGeneration === source.generation &&
          binding.sourceEpoch === source.source_epoch &&
          binding.sourceOwner === source.source_owner &&
          binding.restoreGeneration === restoreGeneration
          ? binding
          : null;
      });
    },
    async registerAuthReceivingClosure({ barrier: expected, deadline }) {
      shape(expected, false);
      return receivingTransaction(pool, deadline, async (tx) => {
        const route = routeOf(expected.accountId)!;
        const partition = Math.floor(route / 16);
        const source = await receivingSource(tx, partition);
        if (!source) return { state: 'pending', reason: 'source-unavailable' } as const;
        // This record is an obligation, not installation. The native trigger
        // forbids fabricating any physical identity from Source's generation.
        await tx.query(
          `INSERT INTO access.auth_receiving_control
          (partition_no,source_generation,source_epoch,source_owner) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [partition, source.generation, source.source_epoch, source.source_owner],
        );
        await tx.query('SELECT partition_no FROM access.auth_receiving_control WHERE partition_no=$1 FOR SHARE', [
          partition,
        ]);
        if (!(await receivingRoot(tx, expected))) throw deny();
        await tx.query(
          `INSERT INTO access.auth_receiving_obligation(route,account_id,version,at,partition_no)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [route, expected.accountId, expected.version, expected.at, partition],
        );
        const binding = await receivingBinding(tx, partition);
        if (
          !binding ||
          binding.sourceGeneration !== source.generation ||
          binding.sourceEpoch !== source.source_epoch ||
          binding.sourceOwner !== source.source_owner
        )
          return { state: 'pending', reason: 'physical-owner-unavailable' } as const;
        return { state: 'bound', binding } as const;
      });
    },
    async invalidateAuthReceivingClosure({ partition, restoreGeneration, deadline }) {
      if (
        !Number.isInteger(partition) ||
        partition < 0 ||
        partition >= 4096 ||
        typeof restoreGeneration !== 'string' ||
        Buffer.byteLength(restoreGeneration) < 1 ||
        Buffer.byteLength(restoreGeneration) > 1024
      )
        throw deny();
      return receivingTransaction(pool, deadline, async (tx) => {
        const source = await receivingSource(tx, partition);
        if (!source) return false;
        await tx.query(
          `INSERT INTO access.auth_receiving_control
          (partition_no,source_generation,source_epoch,source_owner) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [partition, source.generation, source.source_epoch, source.source_owner],
        );
        const control = (
          await tx.query<{ requested_restore: string | null }>(
            'SELECT requested_restore FROM access.auth_receiving_control WHERE partition_no=$1 FOR UPDATE',
            [partition],
          )
        ).rows[0];
        if (!control) return false;
        if (control.requested_restore !== restoreGeneration)
          await tx.query(
            `UPDATE access.auth_receiving_control SET revision=revision+1,state='quarantined',requested_restore=$2
            WHERE partition_no=$1`,
            [partition, restoreGeneration],
          );
        return true;
      });
    },
    async publishAuthReceivingClosure({ barrier: expected, nativeObligationId, deadline }) {
      if (!/^[1-9][0-9]{0,18}$/.test(nativeObligationId) || BigInt(nativeObligationId) > 9223372036854775807n)
        throw deny();
      const registration = await ports.registerAuthReceivingClosure({ barrier: expected, deadline });
      if (registration.state !== 'bound') return false;
      // Released native home, then released Auth read. Only the private factory
      // reads its durable receipt; a caller cannot supply a publication blob.
      const receipt = await within(deadline, async () =>
        producer()?.readClosure({
          barrier: expected,
          nativeObligationId,
          binding: registration.binding,
          deadline,
        }),
      );
      if (
        !receipt ||
        receipt.format !== AUTH_RECEIVING_CLOSURE_NATIVE_GUARD ||
        receipt.nativeObligationId !== nativeObligationId ||
        !uuid(receipt.closureReceiptId) ||
        !same(receipt.binding, registration.binding)
      )
        return false;
      shape(receipt.source, true);
      if (
        receipt.source.accountId !== expected.accountId ||
        receipt.source.version !== expected.version ||
        receipt.source.at !== expected.at
      )
        return false;
      return receivingTransaction(pool, deadline, async (tx) => {
        const binding = registration.binding;
        const source = await receivingSource(tx, binding.partition);
        if (
          !source ||
          source.generation !== binding.sourceGeneration ||
          source.source_epoch !== binding.sourceEpoch ||
          source.source_owner !== binding.sourceOwner ||
          !same(await receivingBinding(tx, binding.partition), binding) ||
          !(await receivingRoot(tx, expected))
        )
          return false;
        const route = routeOf(expected.accountId)!;
        const custody = (
          await tx.query<{ physical_closure: string; receiving_closure: string }>(
            `SELECT physical_closure,receiving_closure FROM access.auth_receiving_obligation
           WHERE route=$1 AND account_id=$2 AND version=$3 AND at=$4::timestamptz AND custody_revision=$5::bigint
           AND physical_closure IS NOT NULL AND receiving_closure IS NOT NULL FOR SHARE`,
            [route, expected.accountId, expected.version, expected.at, binding.controlRevision],
          )
        ).rows[0];
        if (!custody || !(await readAuthNativeConsumption(tx, receipt.source))) return false;
        await tx.query(
          `INSERT INTO access.auth_receiving_closure(route,account_id,control_revision,version,at,
          native_obligation_id,closure_receipt_id,physical_closure,receiving_closure,continuation_id,source_receipt_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
          [
            route,
            expected.accountId,
            binding.controlRevision,
            expected.version,
            expected.at,
            nativeObligationId,
            receipt.closureReceiptId,
            custody.physical_closure,
            custody.receiving_closure,
            receipt.source.continuationId,
            receipt.source.receiptId,
          ],
        );
        return same(await currentReceipt(tx, expected), {
          barrier: receivingBarrier(expected),
          binding,
          nativeObligationId,
          closureReceiptId: receipt.closureReceiptId,
          continuationId: receipt.source.continuationId,
          sourceReceiptId: receipt.source.receiptId,
        });
      });
    },
  };
  return ports;
}

export async function prepareCurrentAuthReceivingClosure(
  deps: { pool: Pool; clock?: () => Date },
  expected: AuthErasureBarrier,
  context: { deadline: number },
): Promise<CurrentAuthReceivingClosure | null> {
  shape(expected, false);
  if ((deps.clock?.() ?? new Date()).getTime() >= context.deadline) return null;
  const receipt = await receivingTransaction(deps.pool, context.deadline, (tx) => currentReceipt(tx, expected));
  return receipt
    ? (Object.freeze({
        [locator]: Object.freeze({
          ...receipt,
          barrier: Object.freeze(receipt.barrier),
          binding: Object.freeze(receipt.binding),
        }),
      }) as Issued)
    : null;
}
export async function verifyCurrentAuthReceivingClosure(
  tx: PoolClient,
  expected: AuthErasureBarrier,
  proof: CurrentAuthReceivingClosure,
): Promise<boolean> {
  shape(expected, false);
  if (!proof || typeof proof !== 'object' || !(locator in proof)) return false;
  const issued = (proof as Issued)[locator];
  // Autocommit releases locks before the next statement; it cannot certify a
  // destructive transaction. Assign an xid and demand it remains live afterward.
  const xid = (await tx.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid')).rows[0]?.xid;
  if (!xid) return false;
  const current = await currentReceipt(tx, expected);
  const live = (await tx.query<{ xid: string | null }>('SELECT pg_current_xact_id_if_assigned()::text AS xid')).rows[0]
    ?.xid;
  return xid === live && current !== null && same(current, issued);
}
/** Current semantics intentionally exclude legacy unbound copies-erased rows. */
export async function readAuthHistoryCompletion(pool: Pool, expected: AuthErasureBarrier): Promise<boolean> {
  return (await prepareCurrentAuthReceivingClosure({ pool }, expected, { deadline: Date.now() + 5000 })) !== null;
}

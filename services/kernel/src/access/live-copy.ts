import { createHash } from 'node:crypto';
import { hasLiveCommandTransaction, currentCommand, type CommandTransaction } from '../command/command.ts';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import {
  currentOperationalResources,
  hasLiveOperationalTransaction,
  runOperationalTransaction,
  type OperationalTransaction,
} from '../command/operational.ts';
import { withConnection } from '../database/pool.ts';
import { partitionOf, routeOf, newId } from '../route/route.ts';
import type { WorkClient } from '../work/client.ts';
import { CommandUnavailableError } from './unavailable.ts';
import { encodeLocator } from '../history/locator.ts';
import { validateRoleMask } from '../history/contracts.ts';

/** Internal native business-copy protocol. It grants no Access or Source authority. */
export type LiveCopyModule = 'commerce.creator-sale' | 'library.subject-listing';
export type LiveCopyRole = Readonly<{ accountId: string; roles: number }>;
export type LiveCopyLocator = Readonly<{ route: number; transitionId: string }>;
export type LiveCopyDomain = Readonly<{ partition: number; domainId: string; epoch: number; node: string }>;
export type LiveCopy = Readonly<{
  route: number;
  transition_id: string;
  module: LiveCopyModule;
  source_domain: string;
  source_epoch: number;
  effect_key: Record<string, unknown>;
  receiver_route: number;
  receiver_domain: string;
  receiver_epoch: number;
  payload: Record<string, unknown> | null;
  roles: readonly LiveCopyRole[] | null;
  state: 'pending' | 'complete' | 'retired';
  result_id: string | null;
  outcome: LiveCopyResult['outcome'] | null;
}>;
export type LiveCopyResult = Readonly<{ resultId: string; outcome: 'applied' | 'cancelled' | 'superseded' }>;
export type LiveCopyDependencies = { pool: Pool; client: WorkClient };
/** Missing native admission evidence is pending, never an empty inventory or an ACK. */
export class LiveCopyPendingError extends Error {}
type Client = Pick<PoolClient, 'query'>;
const SELECT = `SELECT route,transition_id,module,source_domain,source_epoch,effect_key,receiver_route,
 receiver_domain,receiver_epoch,payload,roles,state,result_id,outcome FROM access.live_copy_transition`;
const observed = new WeakSet<object>();
const admissions = new WeakMap<object, LiveCopy>();
export type LiveCopyAdmissions = { readonly nativeAdmissions: unique symbol };
function require(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function same(a: unknown, b: unknown) {
  require(isDeepStrictEqual(a, b), 'Live copy immutable effect conflict');
}
function observe(copy: LiveCopy): LiveCopy {
  const freeze = (value: unknown): void => {
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  freeze(copy);
  observed.add(copy);
  return copy;
}
export function liveCopyLocator(copy: LiveCopy): LiveCopyLocator {
  return { route: copy.route, transitionId: copy.transition_id };
}
function roster(roles: readonly LiveCopyRole[]): readonly LiveCopyRole[] {
  const byAccount = new Map<string, number>();
  for (const role of roles) {
    require(routeOf(role.accountId) !== null && validateRoleMask(role.roles) > 0, 'Invalid live copy role');
    byAccount.set(role.accountId, (byAccount.get(role.accountId) ?? 0) | role.roles);
  }
  const result = [...byAccount]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([accountId, roles]) => ({ accountId, roles }));
  require(result.length <= 64 &&
    Buffer.byteLength(JSON.stringify(result)) <= 8192, 'Live copy role roster exceeds native bound');
  return result;
}
/** Exact original native event role basis; no caller/event-JSON role inference. */
export async function liveCopyEventRoles(
  tx: Client,
  input: { partition: number; position: string; eventSeq: number; requireInventory?: boolean },
  extra: readonly LiveCopyRole[],
) {
  const locator = Buffer.from(
    encodeLocator({
      artifactType: 'outbox-event/v1',
      partitionNo: input.partition,
      position: BigInt(input.position),
      eventSeq: input.eventSeq,
    }),
  );
  const rows = await tx.query<{ account_id: string; roles: number }>(
    `SELECT account_id,roles FROM core.history_locator WHERE partition_no=$1 AND artifact_type='outbox-event/v1'
     AND locator=$2 ORDER BY account_route,account_id LIMIT 65`,
    [input.partition, locator],
  );
  require(rows.rows.length <= 64, 'Live copy original event has too many personal roles');
  if (input.requireInventory && !rows.rows.length)
    throw new LiveCopyPendingError('Live copy original delegated role inventory unavailable');
  return roster([...extra, ...rows.rows.map((r) => ({ accountId: r.account_id, roles: r.roles }))]);
}
async function readHome<T>(pool: Pool, body: (tx: Client) => Promise<T>): Promise<T> {
  return withConnection(pool, async (tx) => {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      await tx.query("SET LOCAL statement_timeout='2000ms'");
      await tx.query("SET LOCAL lock_timeout='2000ms'");
      const result = await body(tx);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    }
  });
}
/** Native placement must have been admitted by migration, never initialized by a writer. */
export async function readLiveCopyDomain(tx: Client, partition: number, lock = true): Promise<LiveCopyDomain> {
  const row = (
    await tx.query<{ domain_id: string; epoch: number; node: string }>(
      `SELECT d.domain_id,d.epoch,d.node FROM access.live_copy_domain d JOIN core.partition p USING(partition_no)
     WHERE d.partition_no=$1 AND d.state='active' AND p.write_state='active' AND (p.node,p.epoch)=(d.node,d.epoch)
       AND p.position>=d.admitted_position ${lock ? 'FOR SHARE OF p,d' : ''}`,
      [partition],
    )
  ).rows[0];
  if (!row) throw new CommandUnavailableError('fenced', partition);
  return { partition, domainId: row.domain_id, epoch: row.epoch, node: row.node };
}
export async function observeLiveCopyDomain(pool: Pool, partition: number) {
  return readHome(pool, (tx) => readLiveCopyDomain(tx, partition));
}
function checkTransaction(tx: OperationalTransaction, partition: number) {
  require(hasLiveOperationalTransaction(tx) &&
    currentOperationalResources(tx).partition === partition, 'Live copy requires its native operational home');
}
function checkReceiverTransaction(tx: OperationalTransaction | CommandTransaction, partition: number) {
  if (hasLiveOperationalTransaction(tx as OperationalTransaction))
    checkTransaction(tx as OperationalTransaction, partition);
  else
    require(hasLiveCommandTransaction(tx as CommandTransaction) &&
      currentCommand(tx as CommandTransaction).partition ===
        partition, 'Live copy requires native receiver transaction');
}
/** Called ONLY by the fixed Commerce/Library source adapter after its exact business read.
 * Original local role holds and the immutable source effect commit before release. */
export async function stageLiveCopy(
  tx: OperationalTransaction,
  input: {
    route: number;
    module: LiveCopyModule;
    effectKey: Record<string, unknown>;
    payload: Record<string, unknown>;
    roles: readonly LiveCopyRole[];
    receiverRoute: number;
    receiver: LiveCopyDomain;
  },
): Promise<LiveCopy> {
  checkTransaction(tx, partitionOf(input.route));
  require(input.receiver.partition === partitionOf(input.receiverRoute), 'Live copy receiver placement conflict');
  require(Buffer.byteLength(JSON.stringify(input.effectKey)) <= 1024 &&
    Buffer.byteLength(JSON.stringify(input.payload)) <= 8192, 'Live copy source exceeds native byte bound');
  const source = await readLiveCopyDomain(tx, partitionOf(input.route));
  const roles = roster(input.roles);
  if (!roles.length) throw new LiveCopyPendingError('Live copy original native personal role basis unavailable');
  const key: Record<string, unknown> = {
    ...input.effectKey,
    receiverDomain: input.receiver.domainId,
    receiverEpoch: input.receiver.epoch,
    receiverRoute: input.receiverRoute,
  };
  require(Buffer.byteLength(JSON.stringify(key)) <= 1024, 'Live copy effect locator exceeds 1KiB');
  require(Object.values(key).every(
    (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value),
  ), 'Live copy native effect keys must be scalar');
  const digest = createHash('sha256')
    .update(
      JSON.stringify(
        Object.keys(key)
          .sort()
          .map((name) => [name, key[name]]),
      ),
    )
    .digest();
  await tx.query(
    `INSERT INTO access.live_copy_transition(route,transition_id,module,source_domain,source_epoch,effect_key,effect_digest,
    receiver_route,receiver_domain,receiver_epoch,payload,roles) VALUES($1,$2,$3,$4,$5,$6,$12,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
    [
      input.route,
      newId(input.route),
      input.module,
      source.domainId,
      source.epoch,
      JSON.stringify(key),
      input.receiverRoute,
      input.receiver.domainId,
      input.receiver.epoch,
      JSON.stringify(input.payload),
      JSON.stringify(roles),
      digest,
    ],
  );
  const copy = (
    await tx.query<LiveCopy>(
      `${SELECT} WHERE route=$1 AND module=$2 AND source_domain=$3 AND effect_digest=$4 FOR UPDATE`,
      [input.route, input.module, source.domainId, digest],
    )
  ).rows[0];
  require(copy && copy.state !== 'retired', 'Live copy source effect retired');
  same(copy.effect_key, key);
  same(copy.payload, input.payload);
  same(copy.roles, roles);
  observe(copy);
  if (copy.state === 'pending') {
    await enroll(tx, copy, 'source');
    for (const [index, role] of roles.entries())
      if (partitionOf(routeOf(role.accountId)!) === source.partition)
        if (!(await hold(tx, copy, index, role)))
          throw new LiveCopyPendingError('Live copy source role is terminal or unavailable');
  }
  return copy;
}
/** All reads release their checkout before a role or receiver-home transaction. */
export async function readLiveCopy(pool: Pool, locator: LiveCopyLocator): Promise<LiveCopy | null> {
  require(routeOf(locator.transitionId) === locator.route, 'Invalid live copy source locator');
  return readHome(pool, async (tx) => {
    const domain = await readLiveCopyDomain(tx, partitionOf(locator.route));
    const copy = (
      await tx.query<LiveCopy>(`${SELECT} WHERE route=$1 AND transition_id=$2`, [locator.route, locator.transitionId])
    ).rows[0];
    if (!copy) return null;
    require(copy.source_domain === domain.domainId &&
      copy.source_epoch === domain.epoch, 'Live copy source incarnation unavailable');
    return observe(copy);
  });
}
async function enroll(tx: Client, copy: LiveCopy, item: 'source' | 'receiver') {
  require(copy.roles, 'Live copy roster unavailable');
  const route = item === 'source' ? copy.route : copy.receiver_route;
  await tx.query(
    `INSERT INTO access.live_copy_inventory(route,account_id,item,source_domain,transition_id)
    SELECT $1,(r->>'accountId')::uuid,$2,$3,$4 FROM jsonb_array_elements($5::jsonb) r ON CONFLICT DO NOTHING`,
    [route, item, copy.source_domain, copy.transition_id, JSON.stringify(copy.roles)],
  );
}
async function hold(tx: OperationalTransaction, copy: LiveCopy, index: number, role: LiveCopyRole): Promise<boolean> {
  const route = routeOf(role.accountId)!;
  checkTransaction(tx, partitionOf(route));
  const domain = await readLiveCopyDomain(tx, partitionOf(route));
  await tx.query(
    `INSERT INTO access.live_copy_role_gate(route,source_domain,transition_id,role_index) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [route, copy.source_domain, copy.transition_id, index],
  );
  const gate = (
    await tx.query<{ result_id: string | null }>(
      `SELECT result_id FROM access.live_copy_role_gate WHERE route=$1 AND source_domain=$2 AND transition_id=$3 AND role_index=$4 FOR UPDATE`,
      [route, copy.source_domain, copy.transition_id, index],
    )
  ).rows[0]!;
  if (gate.result_id !== null) return false;
  const account = (
    await tx.query<{ state: string; authn_fenced: boolean }>(
      `SELECT state,authn_fenced FROM access.account WHERE route=$1 AND account_id=$2 FOR UPDATE`,
      [route, role.accountId],
    )
  ).rows[0];
  if (!account || account.state !== 'active' || account.authn_fenced) return false;
  await tx.query(
    `INSERT INTO access.live_copy_hold(route,account_id,transition_id,source_route,source_domain,
    receiver_route,receiver_domain,receiver_epoch,account_domain,roles,role_index,reservation_id,source_transaction_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
    [
      route,
      role.accountId,
      copy.transition_id,
      copy.route,
      copy.source_domain,
      copy.receiver_route,
      copy.receiver_domain,
      copy.receiver_epoch,
      domain.domainId,
      role.roles,
      index,
      newId(route),
      copy.effect_key.transactionId,
    ],
  );
  const h = (
    await tx.query<{
      reservation_id: string;
      result_id: string | null;
      account_domain: string;
      roles: number;
      source_route: number;
      receiver_domain: string;
      receiver_epoch: number;
      receiver_route: number;
      role_index: number;
      source_transaction_id: string;
    }>(
      `SELECT reservation_id,result_id,account_domain,roles,source_route,receiver_domain,receiver_epoch,receiver_route,role_index,source_transaction_id FROM access.live_copy_hold
    WHERE route=$1 AND account_id=$2 AND source_domain=$3 AND transition_id=$4`,
      [route, role.accountId, copy.source_domain, copy.transition_id],
    )
  ).rows[0]!;
  require(h.result_id === null &&
    h.account_domain === domain.domainId &&
    h.roles === role.roles &&
    h.source_route === copy.route &&
    h.receiver_route === copy.receiver_route &&
    h.receiver_domain === copy.receiver_domain &&
    h.receiver_epoch === copy.receiver_epoch &&
    h.role_index === index &&
    h.source_transaction_id === copy.effect_key.transactionId, 'Live copy native hold conflict');
  // related_account_id is deliberately the same native role account, never a business object.
  await tx.query(
    `INSERT INTO access.lifecycle_coordination(route,account_id,reservation_id,related_account_id,purpose,transaction_id)
    VALUES($1,$2,$3,$2,'live-copy',$4) ON CONFLICT DO NOTHING`,
    [route, role.accountId, h.reservation_id, copy.effect_key.transactionId],
  );
  await tx.query(
    `INSERT INTO access.live_copy_inventory(route,account_id,item,source_domain,transition_id) VALUES($1,$2,'hold',$3,$4) ON CONFLICT DO NOTHING`,
    [route, role.accountId, copy.source_domain, copy.transition_id],
  );
  return true;
}
/** Partial admission is retained. False requires exact receiver cancellation, then consume. */
export async function admitLiveCopyRoles(deps: LiveCopyDependencies, copy: LiveCopy): Promise<boolean> {
  require(observed.has(copy) && copy.roles && copy.state === 'pending', 'Fresh native live copy source required');
  for (const [index, role] of copy.roles.entries()) {
    const held = await runOperationalTransaction(
      deps.pool,
      {
        mode: 'work-step',
        partition: partitionOf(routeOf(role.accountId)!),
        kind: 'access.liveCopy.hold',
        accounts: [],
        workClient: deps.client,
      },
      (tx) => hold(tx, copy, index, role),
    );
    if (!held) return false;
  }
  return true;
}
/** Fixed Access adapter observes genuine holds, never an allow boolean supplied by a consumer. */
export async function observeLiveCopyAdmissions(pool: Pool, copy: LiveCopy): Promise<LiveCopyAdmissions | null> {
  require(observed.has(copy) && copy.roles, 'Fresh native live copy source required');
  for (const [index, role] of copy.roles.entries()) {
    const route = routeOf(role.accountId)!;
    const valid = await readHome(pool, async (tx) => {
      const domain = await readLiveCopyDomain(tx, partitionOf(route));
      const rows = await tx.query(
        `SELECT 1 FROM access.live_copy_hold h JOIN access.lifecycle_coordination c
        ON (c.route,c.account_id,c.reservation_id)=(h.route,h.account_id,h.reservation_id)
        JOIN access.live_copy_role_gate g ON (g.route,g.source_domain,g.transition_id,g.role_index)=(h.route,h.source_domain,h.transition_id,h.role_index)
        WHERE h.route=$1 AND h.account_id=$2 AND h.source_domain=$3 AND h.transition_id=$4
          AND h.source_route=$5 AND h.receiver_route=$6 AND h.receiver_domain=$7 AND h.receiver_epoch=$8
          AND h.account_domain=$9 AND h.roles=$10 AND h.role_index=$11 AND h.result_id IS NULL AND g.result_id IS NULL
          AND h.source_transaction_id=$12
          AND c.purpose='live-copy' AND c.related_account_id=h.account_id AND c.transaction_id=h.source_transaction_id`,
        [
          route,
          role.accountId,
          copy.source_domain,
          copy.transition_id,
          copy.route,
          copy.receiver_route,
          copy.receiver_domain,
          copy.receiver_epoch,
          domain.domainId,
          role.roles,
          index,
          copy.effect_key.transactionId,
        ],
      );
      return rows.rowCount === 1;
    });
    if (!valid) return null;
  }
  const proof = Object.freeze({}) as LiveCopyAdmissions;
  admissions.set(proof, copy);
  return proof;
}
type Gate = {
  outcome: 'applying' | LiveCopyResult['outcome'];
  result_id: string;
  receiver_domain: string;
  receiver_epoch: number;
  module: LiveCopyModule;
  effect_key: unknown;
  payload: unknown;
  roles: unknown;
  retired: boolean;
};
/** Receiver-local arbitration. The caller is a fixed native module body, never a public callback. */
export async function openLiveCopyGate(
  tx: OperationalTransaction | CommandTransaction,
  copy: LiveCopy,
  proof: LiveCopyAdmissions | null,
  cancel = false,
): Promise<LiveCopyResult | null> {
  checkReceiverTransaction(tx, partitionOf(copy.receiver_route));
  require(observed.has(copy), 'Native live copy transition required');
  if (!cancel) require(proof && admissions.get(proof) === copy, 'Native role admissions required');
  const domain = await readLiveCopyDomain(tx, partitionOf(copy.receiver_route));
  require(domain.domainId === copy.receiver_domain &&
    domain.epoch === copy.receiver_epoch, 'Live copy receiver incarnation unavailable');
  await tx.query(
    `INSERT INTO access.live_copy_gate(route,source_domain,transition_id,receiver_domain,receiver_epoch,module,effect_key,payload,roles,outcome,retired)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
    [
      copy.receiver_route,
      copy.source_domain,
      copy.transition_id,
      copy.receiver_domain,
      copy.receiver_epoch,
      copy.module,
      cancel ? null : JSON.stringify(copy.effect_key),
      cancel ? null : JSON.stringify(copy.payload),
      cancel ? null : JSON.stringify(copy.roles),
      cancel ? 'cancelled' : 'applying',
      cancel,
    ],
  );
  const gate = (
    await tx.query<Gate>(
      `SELECT * FROM access.live_copy_gate WHERE route=$1 AND source_domain=$2 AND transition_id=$3 FOR UPDATE`,
      [copy.receiver_route, copy.source_domain, copy.transition_id],
    )
  ).rows[0]!;
  require(gate.receiver_domain === copy.receiver_domain &&
    gate.receiver_epoch === copy.receiver_epoch &&
    gate.module === copy.module, 'Live copy receiver identity conflict');
  if (gate.retired && (cancel || gate.outcome === 'cancelled'))
    return { resultId: gate.result_id, outcome: gate.outcome as LiveCopyResult['outcome'] };
  require(!gate.retired, 'Live copy receiver effect retired');
  same(gate.effect_key, copy.effect_key);
  same(gate.payload, copy.payload);
  same(gate.roles, copy.roles);
  if (gate.outcome === 'applying') {
    require(!cancel, 'Uncommitted live copy gate');
    return null;
  }
  return { resultId: gate.result_id, outcome: gate.outcome };
}
export async function finishLiveCopyGate(
  tx: OperationalTransaction | CommandTransaction,
  copy: LiveCopy,
  outcome: 'applied' | 'superseded',
) {
  checkReceiverTransaction(tx, partitionOf(copy.receiver_route));
  await enroll(tx, copy, 'receiver');
  const row = (
    await tx.query<{ result_id: string }>(
      `UPDATE access.live_copy_gate SET outcome=$4 WHERE route=$1 AND source_domain=$2 AND transition_id=$3 AND outcome='applying' RETURNING result_id`,
      [copy.receiver_route, copy.source_domain, copy.transition_id, outcome],
    )
  ).rows[0];
  require(row, 'Live copy receiver terminal CAS failed');
  return { resultId: row.result_id, outcome };
}
export async function readLiveCopyResult(pool: Pool, copy: LiveCopy): Promise<LiveCopyResult | null> {
  require(observed.has(copy), 'Native live copy source required');
  return readHome(pool, async (tx) => {
    const domain = await readLiveCopyDomain(tx, partitionOf(copy.receiver_route));
    require(domain.domainId === copy.receiver_domain &&
      domain.epoch === copy.receiver_epoch, 'Live copy receiver incarnation unavailable');
    const gate = (
      await tx.query<Gate>(
        `SELECT * FROM access.live_copy_gate WHERE route=$1 AND source_domain=$2 AND transition_id=$3`,
        [copy.receiver_route, copy.source_domain, copy.transition_id],
      )
    ).rows[0];
    if (!gate || gate.outcome === 'applying') return null;
    require(gate.receiver_domain === copy.receiver_domain &&
      gate.receiver_epoch === copy.receiver_epoch &&
      gate.module === copy.module, 'Live copy receiver result conflict');
    if (!gate.retired) {
      same(gate.effect_key, copy.effect_key);
      same(gate.payload, copy.payload);
      same(gate.roles, copy.roles);
    }
    return { resultId: gate.result_id, outcome: gate.outcome };
  });
}
export async function cancelLiveCopy(deps: LiveCopyDependencies, copy: LiveCopy): Promise<LiveCopyResult> {
  return runOperationalTransaction(
    deps.pool,
    {
      mode: 'work-step',
      partition: partitionOf(copy.receiver_route),
      kind: 'access.liveCopy.cancel',
      accounts: [],
      workClient: deps.client,
    },
    async (tx) => {
      const result = await openLiveCopyGate(tx, copy, null, true);
      require(result, 'Live copy cancel result missing');
      return result;
    },
  );
}
/** Receiver checkout is released BEFORE any source-account serialization.
 * Missing holds acquire a terminal role gate, barring a delayed first admission. */
export async function consumeLiveCopy(deps: LiveCopyDependencies, copy: LiveCopy): Promise<LiveCopyResult | null> {
  const result = await readLiveCopyResult(deps.pool, copy);
  if (!result) return null;
  require(copy.roles, 'Live copy roster unavailable');
  for (const [index, role] of copy.roles.entries()) {
    const route = routeOf(role.accountId)!;
    await runOperationalTransaction(
      deps.pool,
      {
        mode: 'work-step',
        partition: partitionOf(route),
        kind: 'access.liveCopy.consume',
        accounts: [],
        workClient: deps.client,
      },
      async (tx) => {
        await readLiveCopyDomain(tx, partitionOf(route));
        await tx.query(`SELECT account_id FROM access.account WHERE route=$1 AND account_id=$2 FOR UPDATE`, [
          route,
          role.accountId,
        ]);
        await tx.query(
          `INSERT INTO access.live_copy_role_gate(route,source_domain,transition_id,role_index,result_id,outcome) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [route, copy.source_domain, copy.transition_id, index, result.resultId, result.outcome],
        );
        const g = (
          await tx.query<{ result_id: string | null; outcome: string | null }>(
            `SELECT result_id,outcome FROM access.live_copy_role_gate WHERE route=$1 AND source_domain=$2 AND transition_id=$3 AND role_index=$4 FOR UPDATE`,
            [route, copy.source_domain, copy.transition_id, index],
          )
        ).rows[0]!;
        if (g.result_id !== null) {
          require(g.result_id === result.resultId && g.outcome === result.outcome, 'Live copy role terminal conflict');
          return;
        }
        const h = (
          await tx.query<{
            reservation_id: string;
            result_id: string | null;
            receiver_domain: string;
            receiver_epoch: number;
            roles: number;
            role_index: number;
            source_route: number;
            receiver_route: number;
            account_domain: string;
            source_transaction_id: string;
          }>(
            `SELECT * FROM access.live_copy_hold WHERE route=$1 AND account_id=$2 AND source_domain=$3 AND transition_id=$4 FOR UPDATE`,
            [route, role.accountId, copy.source_domain, copy.transition_id],
          )
        ).rows[0];
        if (h) {
          require(h.receiver_domain === copy.receiver_domain &&
            h.receiver_epoch === copy.receiver_epoch &&
            h.roles === role.roles &&
            h.role_index === index &&
            h.source_route === copy.route &&
            h.receiver_route === copy.receiver_route &&
            h.source_transaction_id === copy.effect_key.transactionId, 'Live copy consumed hold conflict');
          const d = await readLiveCopyDomain(tx, partitionOf(route));
          require(h.account_domain === d.domainId, 'Live copy role incarnation unavailable');
          await tx.query(
            `UPDATE access.live_copy_hold SET result_id=$5,outcome=$6 WHERE route=$1 AND account_id=$2 AND source_domain=$3 AND transition_id=$4 AND result_id IS NULL`,
            [route, role.accountId, copy.source_domain, copy.transition_id, result.resultId, result.outcome],
          );
          await tx.query(
            `DELETE FROM access.lifecycle_coordination WHERE route=$1 AND account_id=$2 AND reservation_id=$3 AND purpose='live-copy' AND related_account_id=$2 AND transaction_id=$4`,
            [route, role.accountId, h.reservation_id, copy.effect_key.transactionId],
          );
        }
        await tx.query(
          `UPDATE access.live_copy_role_gate SET result_id=$5,outcome=$6 WHERE route=$1 AND source_domain=$2 AND transition_id=$3 AND role_index=$4 AND result_id IS NULL`,
          [route, copy.source_domain, copy.transition_id, index, result.resultId, result.outcome],
        );
      },
    );
  }
  await runOperationalTransaction(
    deps.pool,
    {
      mode: 'work-step',
      partition: partitionOf(copy.route),
      kind: 'access.liveCopy.complete',
      accounts: [],
      workClient: deps.client,
    },
    async (tx) => {
      const d = await readLiveCopyDomain(tx, partitionOf(copy.route));
      require(d.domainId === copy.source_domain &&
        d.epoch === copy.source_epoch, 'Live copy source incarnation unavailable');
      await tx.query(
        `UPDATE access.live_copy_transition SET state='complete',result_id=$3,outcome=$4 WHERE route=$1 AND transition_id=$2 AND state='pending'`,
        [copy.route, copy.transition_id, result.resultId, result.outcome],
      );
      const row = (
        await tx.query<{ result_id: string; outcome: string }>(
          `SELECT result_id,outcome FROM access.live_copy_transition WHERE route=$1 AND transition_id=$2`,
          [copy.route, copy.transition_id],
        )
      ).rows[0];
      require(row?.result_id === result.resultId && row.outcome === result.outcome, 'Live copy completion conflict');
    },
  );
  return result;
}

import type { Pool } from 'pg';
import { withWorkerTelemetry } from '@rezics/observability/runtime';
import { RealmAdminInvalid, RealmAdminUnavailable } from '../realm-admin/contract.ts';
import { deliverRealmPolicy, type RealmPolicyDelivery } from '../space/policy.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';

export const REALM_POLICY_RECOVERY_COST = { page: 10, maxPage: 50, lockTimeoutMs: 2_000,
  statementTimeoutMs: 5_000, graphCommandsPerRealm: 1, intervalMs: 30_000 } as const;
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const columns = 'realm,receipt_id,generation::text,visibility,review_mode';

/** Resume the already committed Access intent, without manufacturing authority.
 * The same Realm gate as settings writes prevents a delayed recovery from
 * publishing an older policy after a newer one. Graph receipt replay covers a
 * crash between graph commit and the Access acknowledgement.
 * FOR UPDATE holds until COMMIT: https://www.postgresql.org/docs/18/explicit-locking.html */
export async function settleRealmPolicy(pool: Pool, realm: string, env?: WorkActivationEnvironment): Promise<boolean> {
  if (!native.test(realm)) throw new RealmAdminInvalid('Invalid Realm');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${REALM_POLICY_RECOVERY_COST.lockTimeoutMs}ms'`);
    await client.query(`SET LOCAL statement_timeout = '${REALM_POLICY_RECOVERY_COST.statementTimeoutMs}ms'`);
    const fence = await client.query('SELECT 1 FROM access.recovery_fence WHERE id AND open FOR SHARE');
    if (!fence.rowCount) throw new RealmAdminUnavailable('Access recovery is in progress');
    // Match settings' lock order: fence, scope gate, delivery.
    await client.query('SELECT 1 FROM access.scope_gate WHERE id = $1 FOR UPDATE', [`governance:realm:${realm}`]);
    const pending = (await client.query<RealmPolicyDelivery>(`SELECT ${columns}
      FROM access.realm_policy_delivery WHERE realm = $1 AND NOT delivered FOR UPDATE`, [realm])).rows[0];
    if (pending) {
      if (!env) throw new RealmAdminUnavailable('Realm policy delivery needs the graph owner');
      await deliverRealmPolicy(env, pending);
      await client.query(`UPDATE access.realm_policy_delivery SET delivered = true WHERE realm = $1 AND receipt_id = $2`,
        [realm, pending.receipt_id]);
    }
    await client.query('COMMIT');
    return !!pending;
  } catch (cause) {
    await client.query('ROLLBACK').catch(() => {});
    if (cause instanceof RealmAdminUnavailable) throw cause;
    throw new RealmAdminUnavailable('Realm policy publication is pending; retry', { cause });
  } finally { client.release(); }
}

export interface RealmPolicyRecoveryPage { items: RealmPolicyDelivery[]; nextCursor: string | null }
/** Primary-key cursor, bounded output; a failed Realm cannot starve later ones. */
export async function pendingRealmPolicies(pool: Pool, after?: string, limit: number = REALM_POLICY_RECOVERY_COST.page): Promise<RealmPolicyRecoveryPage> {
  if (after && !native.test(after) || !Number.isInteger(limit) || limit < 1 || limit > REALM_POLICY_RECOVERY_COST.maxPage) {
    throw new RealmAdminInvalid('Invalid policy recovery page');
  }
  const rows = (await pool.query<RealmPolicyDelivery>(`SELECT ${columns} FROM access.realm_policy_delivery
    WHERE NOT delivered AND ($1::text IS NULL OR realm > $1) ORDER BY realm LIMIT $2`, [after ?? null, limit + 1])).rows;
  return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1]!.realm : null };
}

export async function recoverRealmPolicies(pool: Pool, env: WorkActivationEnvironment, after?: string, limit: number = REALM_POLICY_RECOVERY_COST.page) {
  const page = await pendingRealmPolicies(pool, after, limit);
  const items: { realm: string; receiptId: string; status: 'completed' | 'pending'; error?: string }[] = [];
  for (const intent of page.items) {
    try {
      await settleRealmPolicy(pool, intent.realm, env);
      items.push({ realm: intent.realm, receiptId: intent.receipt_id, status: 'completed' });
    } catch (error) {
      const cause = (error as Error).cause;
      items.push({ realm: intent.realm, receiptId: intent.receipt_id, status: 'pending',
        error: cause instanceof Error ? cause.message : error instanceof Error ? error.message : 'Policy recovery failed' });
    }
  }
  return { items, nextCursor: page.nextCursor };
}

/** Immediate startup recovery plus bounded, non-overlapping retry pages. */
export class RealmPolicyRecoveryWorker {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private stopped = true;
  private after?: string;
  constructor(private readonly pool: Pool, private readonly env: WorkActivationEnvironment) {}
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.tick();
  }
  private tick() {
    this.running = withWorkerTelemetry('main.realm-policy.recovery', () => recoverRealmPolicies(this.pool, this.env, this.after), page => ({
      outcome: page.items.some(item => item.status === 'pending') ? 'retry' : page.items.length ? 'worked' : 'idle',
      processed: page.items.filter(item => item.status === 'completed').length, unit: 'item',
    })).then(page => {
      this.after = page.nextCursor ?? undefined;
      for (const item of page.items) console.info('Realm policy recovery', JSON.stringify(item));
    }).catch(error => { console.warn('Realm policy recovery paused', error); }).finally(() => {
      if (!this.stopped) this.timer = setTimeout(() => { this.tick(); }, REALM_POLICY_RECOVERY_COST.intervalMs);
    });
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }
}

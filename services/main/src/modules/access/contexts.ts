import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';

export class ActingContextDenied extends Error {}
export class ActingContextStale extends Error {}
export class ActingContextUnavailable extends Error {}

export const WORK_CREATE_CONTEXT = {
  task: 'work.create', scope: 'work:create:root', action: 'work.create',
} as const;

export interface ActingContextDiscovery {
  profile: 'work-create-acting-contexts-v1';
  task: typeof WORK_CREATE_CONTEXT.task;
  scope: typeof WORK_CREATE_CONTEXT.scope;
  authorityEpoch: string;
  contexts: Array<{ actingSubject: string }>;
  complete: true;
}

export interface ActingContextCheck {
  profile: 'work-create-acting-context-check-v1';
  task: typeof WORK_CREATE_CONTEXT.task;
  scope: typeof WORK_CREATE_CONTEXT.scope;
  actingSubject: string;
  authorityEpoch: string;
  decision: 'eligible-now';
  reusable: false;
}

const agentId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const epoch = /^(0|[1-9][0-9]*)$/;
const MAX_CONTEXTS = 50;

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    // All authority dependencies in one stable snapshot. A concurrent update
    // to a locked row fails closed under PostgreSQL repeatable-read semantics.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
    if (error && typeof error === 'object' && 'code' in error
      && ['40001', '55P03', '57014'].includes(String(error.code))) {
      throw new ActingContextUnavailable('authority snapshot changed or timed out');
    }
    throw error;
  } finally { client.release(); }
}

async function currentGate(client: PoolClient): Promise<{ authority_epoch: string; open: boolean }> {
  const recovery = await client.query<{ open: boolean }>(
    'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
  if (recovery.rows[0]?.open !== true) {
    throw new ActingContextUnavailable('Access is held for recovery');
  }
  const gate = await client.query<{ authority_epoch: string; open: boolean }>(
    'SELECT authority_epoch, open FROM access.scope_gate WHERE id = $1 FOR SHARE',
    [WORK_CREATE_CONTEXT.scope]);
  if (gate.rowCount !== 1) throw new ActingContextUnavailable('Work creation scope is unavailable');
  return gate.rows[0]!;
}

async function activePrincipal(client: PoolClient, principal: VerifiedPrincipal): Promise<string | null> {
  const result = await client.query<{ id: string }>(`SELECT id FROM access.principal
    WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
  [principal.issuer, principal.subject]);
  return result.rows[0]?.id ?? null;
}

/** A private read model for the first supported task. Discovery is a bounded
 * convenience view; a selected Agent is checked again with its complete path
 * and every later command must still run ordinary Access admission. */
export class AccessActingContexts {
  constructor(private readonly pool: Pool) {}

  async discover(principal: VerifiedPrincipal): Promise<ActingContextDiscovery> {
    return transaction(this.pool, async client => {
      const gate = await currentGate(client);
      const principalId = await activePrincipal(client, principal);
      if (!gate.open || !principalId) return {
        profile: 'work-create-acting-contexts-v1', task: WORK_CREATE_CONTEXT.task,
        scope: WORK_CREATE_CONTEXT.scope, authorityEpoch: gate.authority_epoch,
        contexts: [], complete: true,
      };
      const result = await client.query<{ acting_subject: string }>(`
        SELECT DISTINCT s.id AS acting_subject
        FROM access.representation r
        JOIN access.authority_subject s ON s.id = r.subject_id AND s.active
        WHERE r.principal_id = $1 AND r.action = $2 AND r.active
          AND r.valid_until > clock_timestamp()
          AND EXISTS (SELECT 1 FROM access.permission_grant g
            WHERE g.recipient_subject = s.id AND g.scope_id = $3
              AND g.action = $2 AND g.active AND g.valid_until > clock_timestamp())
        ORDER BY s.id LIMIT $4`,
      [principalId, WORK_CREATE_CONTEXT.action, WORK_CREATE_CONTEXT.scope,
        MAX_CONTEXTS + 1]);
      if (result.rows.length > MAX_CONTEXTS) {
        throw new ActingContextUnavailable('acting context discovery exceeds supported limit');
      }
      return { profile: 'work-create-acting-contexts-v1', task: WORK_CREATE_CONTEXT.task,
        scope: WORK_CREATE_CONTEXT.scope, authorityEpoch: gate.authority_epoch,
        contexts: result.rows.map(row => ({ actingSubject: row.acting_subject })),
        complete: true };
    });
  }

  async check(principal: VerifiedPrincipal, actingSubject: string,
    expectedAuthorityEpoch: string): Promise<ActingContextCheck> {
    if (!agentId.test(actingSubject) || !epoch.test(expectedAuthorityEpoch)) {
      throw new ActingContextDenied('invalid selected context');
    }
    return transaction(this.pool, async client => {
      const gate = await currentGate(client);
      if (gate.authority_epoch !== expectedAuthorityEpoch) {
        throw new ActingContextStale('Work creation authority epoch changed');
      }
      if (!gate.open) throw new ActingContextDenied('Work creation scope is closed');
      const principalId = await activePrincipal(client, principal);
      if (!principalId) throw new ActingContextDenied('principal is not admitted');
      const subject = await client.query(`SELECT id FROM access.authority_subject
        WHERE id = $1 AND active FOR SHARE`, [actingSubject]);
      const represented = await client.query(`SELECT id FROM access.representation
        WHERE principal_id = $1 AND subject_id = $2 AND action = $3
          AND active AND valid_until > clock_timestamp()
        ORDER BY id LIMIT 1 FOR SHARE`,
      [principalId, actingSubject, WORK_CREATE_CONTEXT.action]);
      const granted = await client.query(`SELECT id FROM access.permission_grant
        WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3
          AND active AND valid_until > clock_timestamp()
        ORDER BY id LIMIT 1 FOR SHARE`,
      [actingSubject, WORK_CREATE_CONTEXT.scope, WORK_CREATE_CONTEXT.action]);
      if (subject.rowCount !== 1 || represented.rowCount !== 1 || granted.rowCount !== 1) {
        throw new ActingContextDenied('selected Agent has no complete authority path');
      }
      return { profile: 'work-create-acting-context-check-v1',
        task: WORK_CREATE_CONTEXT.task, scope: WORK_CREATE_CONTEXT.scope,
        actingSubject, authorityEpoch: gate.authority_epoch,
        decision: 'eligible-now', reusable: false };
    });
  }
}

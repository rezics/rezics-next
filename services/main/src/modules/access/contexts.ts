import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import { directWorkCreateProof } from './direct-principal.ts';
import { groupWorkCreateProof, GroupUnavailable } from './groups.ts';

export class ActingContextDenied extends Error {}
export class ActingContextInvalid extends Error {}
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
  directContexts: Array<{ actingSubject: string }>;
  preferredActingSubject: string | null;
  preferenceRevision: string | null;
  complete: true;
}

export interface ActingContextPreference {
  profile: 'work-create-acting-context-preference-v1';
  task: typeof WORK_CREATE_CONTEXT.task;
  actingSubject: string | null;
  revision: string;
  replayed: boolean;
}

export interface SetActingContextPreference {
  actingSubject: string | null;
  expectedRevision: string | null;
  idempotencyKey: string;
}

export interface ActingContextCheck {
  profile: 'work-create-acting-context-check-v1';
  task: typeof WORK_CREATE_CONTEXT.task;
  scope: typeof WORK_CREATE_CONTEXT.scope;
  actingSubject: string;
  authorityPath: 'represented-agent' | 'direct-principal';
  authorityEpoch: string;
  decision: 'eligible-now';
  reusable: false;
}

const agentId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const epoch = /^(0|[1-9][0-9]*)$/;
const revisionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_CONTEXTS = 50;

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>,
  isolation: 'REPEATABLE READ' | 'READ COMMITTED' = 'REPEATABLE READ'): Promise<T> {
  const client = await pool.connect();
  try {
    // Discovery/check use one stable snapshot; preference writes serialize on
    // the principal row and lock their authority dependencies before mutation.
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
    if (error instanceof GroupUnavailable) {
      throw new ActingContextUnavailable(error.message);
    }
    if (error && typeof error === 'object' && 'code' in error
      && ['40001', '55P03', '57014'].includes(String(error.code))) {
      throw new ActingContextUnavailable('authority snapshot changed or timed out');
    }
    throw error;
  } finally { client.release(); }
}

async function currentGate(client: PoolClient): Promise<{
  authority_epoch: string; open: boolean; dispatch_open: boolean;
}> {
  const recovery = await client.query<{ open: boolean }>(
    'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
  if (recovery.rows[0]?.open !== true) {
    throw new ActingContextUnavailable('Access is held for recovery');
  }
  const gate = await client.query<{
    authority_epoch: string; open: boolean; dispatch_open: boolean;
  }>(
    'SELECT authority_epoch, open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR SHARE',
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

async function eligibleSubject(client: PoolClient, principalId: string,
  actingSubject: string): Promise<boolean> {
  const subject = await client.query(`SELECT id FROM access.authority_subject
    WHERE id = $1 AND kind = 'agent' AND active FOR SHARE`, [actingSubject]);
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
  if (subject.rowCount !== 1 || represented.rowCount !== 1) return false;
  return granted.rowCount === 1 || await groupWorkCreateProof(client, actingSubject) !== null;
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
      const preference = principalId ? (await client.query<{
        acting_subject: string | null; revision: string;
      }>(`SELECT acting_subject, revision FROM access.acting_context_preference
          WHERE principal_id = $1 AND task = $2`,
      [principalId, WORK_CREATE_CONTEXT.task])).rows[0] : undefined;
      if (!gate.open || !gate.dispatch_open || !principalId) return {
        profile: 'work-create-acting-contexts-v1', task: WORK_CREATE_CONTEXT.task,
        scope: WORK_CREATE_CONTEXT.scope, authorityEpoch: gate.authority_epoch,
        contexts: [], directContexts: [], preferredActingSubject: null,
        preferenceRevision: preference?.revision ?? null, complete: true,
      };
      const result = await client.query<{ acting_subject: string }>(`
        SELECT DISTINCT s.id AS acting_subject
        FROM access.representation r
        JOIN access.authority_subject s ON s.id = r.subject_id AND s.kind = 'agent' AND s.active
        WHERE r.principal_id = $1 AND r.action = $2 AND r.active
          AND r.valid_until > clock_timestamp()
        ORDER BY s.id LIMIT $3`,
      [principalId, WORK_CREATE_CONTEXT.action, MAX_CONTEXTS + 1]);
      if (result.rows.length > MAX_CONTEXTS) {
        throw new ActingContextUnavailable('acting context discovery exceeds supported limit');
      }
      const contexts: Array<{ actingSubject: string }> = [];
      for (const row of result.rows) {
        const granted = await client.query(`SELECT id FROM access.permission_grant
          WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3
            AND active AND valid_until > clock_timestamp() LIMIT 1`,
        [row.acting_subject, WORK_CREATE_CONTEXT.scope, WORK_CREATE_CONTEXT.action]);
        if (granted.rows[0] || await groupWorkCreateProof(client, row.acting_subject)) {
          contexts.push({ actingSubject: row.acting_subject });
        }
      }
      const direct = await client.query<{ acting_subject: string }>(`
        SELECT DISTINCT s.id AS acting_subject
        FROM access.principal_agent_attribution a
        JOIN access.authority_subject s ON s.id = a.agent_subject
        WHERE a.principal_id = $1 AND a.action = $2 AND a.active
          AND a.valid_until > clock_timestamp() AND s.kind = 'agent' AND s.active
          AND EXISTS (SELECT 1 FROM access.principal_permission_grant g
            WHERE g.principal_id = $1 AND g.scope_id = $3 AND g.action = $2
              AND g.active AND g.valid_until > clock_timestamp())
        ORDER BY s.id LIMIT $4`,
      [principalId, WORK_CREATE_CONTEXT.action, WORK_CREATE_CONTEXT.scope,
        MAX_CONTEXTS + 1]);
      if (direct.rows.length > MAX_CONTEXTS || contexts.length + direct.rows.length > MAX_CONTEXTS) {
        throw new ActingContextUnavailable('acting context discovery exceeds supported limit');
      }
      const directContexts = direct.rows.map(row => ({ actingSubject: row.acting_subject }));
      return { profile: 'work-create-acting-contexts-v1', task: WORK_CREATE_CONTEXT.task,
        scope: WORK_CREATE_CONTEXT.scope, authorityEpoch: gate.authority_epoch,
        contexts, directContexts,
        preferredActingSubject: contexts.some(row => row.actingSubject === preference?.acting_subject)
          ? preference!.acting_subject : null,
        preferenceRevision: preference?.revision ?? null,
        complete: true };
    });
  }

  async check(principal: VerifiedPrincipal, actingSubject: string,
    expectedAuthorityEpoch: string,
    authorityPath: 'represented-agent' | 'direct-principal' = 'represented-agent'):
    Promise<ActingContextCheck> {
    if (!agentId.test(actingSubject) || !epoch.test(expectedAuthorityEpoch)) {
      throw new ActingContextInvalid('invalid selected context');
    }
    return transaction(this.pool, async client => {
      const gate = await currentGate(client);
      if (gate.authority_epoch !== expectedAuthorityEpoch) {
        throw new ActingContextStale('Work creation authority epoch changed');
      }
      if (!gate.open || !gate.dispatch_open) {
        throw new ActingContextDenied('Work creation scope or dispatch is closed');
      }
      const principalId = await activePrincipal(client, principal);
      if (!principalId) throw new ActingContextDenied('principal is not admitted');
      const eligible = authorityPath === 'direct-principal'
        ? await directWorkCreateProof(client, principalId, actingSubject) !== null
        : await eligibleSubject(client, principalId, actingSubject);
      if (!eligible) {
        throw new ActingContextDenied('selected context has no complete authority path');
      }
      return { profile: 'work-create-acting-context-check-v1',
        task: WORK_CREATE_CONTEXT.task, scope: WORK_CREATE_CONTEXT.scope,
        actingSubject, authorityPath, authorityEpoch: gate.authority_epoch,
        decision: 'eligible-now', reusable: false };
    });
  }

  async setPreference(principal: VerifiedPrincipal,
    input: SetActingContextPreference): Promise<ActingContextPreference> {
    if ((input.actingSubject !== null && !agentId.test(input.actingSubject))
      || (input.expectedRevision !== null && !revisionId.test(input.expectedRevision))
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey)) {
      throw new ActingContextInvalid('invalid acting context preference');
    }
    const digest = createHash('sha256').update(JSON.stringify({
      task: WORK_CREATE_CONTEXT.task, actingSubject: input.actingSubject,
      expectedRevision: input.expectedRevision,
    })).digest('hex');
    return transaction(this.pool, async client => {
      const gate = await currentGate(client);
      const principalRow = await client.query<{ id: string }>(`SELECT id FROM access.principal
        WHERE account_issuer = $1 AND account_subject = $2 AND active FOR UPDATE`,
      [principal.issuer, principal.subject]);
      const principalId = principalRow.rows[0]?.id;
      if (!principalId) throw new ActingContextDenied('principal is not admitted');
      const receipt = (await client.query<{
        request_digest: string; acting_subject: string | null; revision: string;
      }>(`SELECT request_digest, acting_subject, revision
          FROM access.acting_context_preference_receipt
          WHERE principal_id = $1 AND idempotency_key = $2`,
      [principalId, input.idempotencyKey])).rows[0];
      if (receipt) {
        if (receipt.request_digest !== digest) {
          throw new ActingContextStale('preference idempotency key was reused');
        }
        return { profile: 'work-create-acting-context-preference-v1',
          task: WORK_CREATE_CONTEXT.task, actingSubject: receipt.acting_subject,
          revision: receipt.revision, replayed: true };
      }
      const prior = (await client.query<{ revision: string }>(`
        SELECT revision FROM access.acting_context_preference
        WHERE principal_id = $1 AND task = $2 FOR UPDATE`,
      [principalId, WORK_CREATE_CONTEXT.task])).rows[0];
      if ((prior?.revision ?? null) !== input.expectedRevision) {
        throw new ActingContextStale('acting context preference revision changed');
      }
      if (input.actingSubject !== null) {
        if (!gate.open || !gate.dispatch_open
          || !await eligibleSubject(client, principalId, input.actingSubject)) {
          throw new ActingContextDenied('preferred Agent is unavailable for this task');
        }
      }
      const revision = randomUUID();
      const written = await client.query(`INSERT INTO access.acting_context_preference
        (principal_id, task, acting_subject, revision) VALUES ($1,$2,$3,$4)
        ON CONFLICT (principal_id, task) DO UPDATE
          SET acting_subject = EXCLUDED.acting_subject, revision = EXCLUDED.revision
          WHERE access.acting_context_preference.revision = $5`,
      [principalId, WORK_CREATE_CONTEXT.task, input.actingSubject, revision,
        input.expectedRevision]);
      if (written.rowCount !== 1) {
        throw new ActingContextStale('acting context preference revision changed');
      }
      await client.query(`INSERT INTO access.acting_context_preference_receipt
        (principal_id, idempotency_key, request_digest, task, acting_subject, revision)
        VALUES ($1,$2,$3,$4,$5,$6)`,
      [principalId, input.idempotencyKey, digest, WORK_CREATE_CONTEXT.task,
        input.actingSubject, revision]);
      return { profile: 'work-create-acting-context-preference-v1',
        task: WORK_CREATE_CONTEXT.task, actingSubject: input.actingSubject,
        revision, replayed: false };
    }, 'READ COMMITTED');
  }
}

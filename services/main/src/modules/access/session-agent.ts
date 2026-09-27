import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import { ActingContextDenied, ActingContextInvalid, ActingContextStale,
  type AccessActingContexts, currentGate, eligibleSubject, transaction } from './contexts.ts';
import { directWorkCreateProof } from './direct-principal.ts';

const agentId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const key = /^[A-Za-z0-9._:-]{1,128}$/;

export interface AgentChoice {
  actingSubject: string | null;
  eligible: boolean;
  revision: string | null;
}

export interface SessionAgentRead {
  profile: 'session-agent-v1';
  sessionAgent: AgentChoice;
  mainAgent: AgentChoice;
  initialActingSubject: string | null;
}

export interface MainAgentRead {
  profile: 'main-agent-preference-v1';
  mainAgent: AgentChoice;
}

export interface AgentChoiceWrite {
  profile: 'session-agent-v1' | 'main-agent-preference-v1';
  actingSubject: string | null;
  revision: string;
  replayed: boolean;
}

export interface SetAgentChoice {
  actingSubject: string | null;
  expectedRevision: string | null;
  idempotencyKey: string;
}

interface SavedChoice { acting_subject: string | null; revision: string }

/** Each read is discovery plus one indexed private lookup. Each write locks one
 * principal and one preference row, checks at most one Agent proof, and writes
 * one head and one receipt. Cost is independent of other sessions and accounts. */
export class AccessSessionAgents {
  constructor(private readonly pool: Pool, private readonly contexts: AccessActingContexts) {}

  private sessionKey(value: string): string {
    if (!uuid.test(value)) throw new ActingContextInvalid('invalid session key');
    return value;
  }

  async readSession(principal: VerifiedPrincipal, sessionKey: string): Promise<SessionAgentRead> {
    this.sessionKey(sessionKey);
    const discovery = await this.contexts.discover(principal);
    const result = await this.pool.query<SavedChoice & {
      session_subject: string | null; session_revision: string | null;
      main_subject: string | null; main_revision: string | null;
    }>(`SELECT s.acting_subject AS session_subject, s.revision AS session_revision,
        m.acting_subject AS main_subject, m.revision AS main_revision
      FROM access.principal p
      LEFT JOIN access.session_agent s ON s.principal_id = p.id AND s.session_key = $3
      LEFT JOIN access.main_agent_preference m ON m.principal_id = p.id
      WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active`,
    [principal.issuer, principal.subject, sessionKey]);
    const row = result.rows[0];
    const eligible = (subject: string | null) => Boolean(subject &&
      [...discovery.contexts, ...discovery.directContexts]
        .some(option => option.actingSubject === subject));
    const sessionAgent = { actingSubject: row?.session_subject ?? null,
      revision: row?.session_revision ?? null, eligible: eligible(row?.session_subject ?? null) };
    const mainAgent = { actingSubject: row?.main_subject ?? null,
      revision: row?.main_revision ?? null, eligible: eligible(row?.main_subject ?? null) };
    const choices = [...new Set([...discovery.contexts, ...discovery.directContexts]
      .map(option => option.actingSubject))];
    return { profile: 'session-agent-v1', sessionAgent, mainAgent,
      initialActingSubject: sessionAgent.revision ? null
        : mainAgent.eligible ? mainAgent.actingSubject
          : choices.length === 1 ? choices[0]! : null };
  }

  async readMain(principal: VerifiedPrincipal): Promise<MainAgentRead> {
    const discovery = await this.contexts.discover(principal);
    const row = (await this.pool.query<SavedChoice>(`SELECT m.acting_subject, m.revision
      FROM access.principal p JOIN access.main_agent_preference m ON m.principal_id = p.id
      WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active`,
    [principal.issuer, principal.subject])).rows[0];
    return { profile: 'main-agent-preference-v1', mainAgent: {
      actingSubject: row?.acting_subject ?? null, revision: row?.revision ?? null,
      eligible: Boolean(row?.acting_subject &&
        [...discovery.contexts, ...discovery.directContexts]
          .some(option => option.actingSubject === row.acting_subject)) } };
  }

  async setSession(principal: VerifiedPrincipal, sessionKey: string,
    input: SetAgentChoice): Promise<AgentChoiceWrite> {
    return this.set(principal, 'session', input, this.sessionKey(sessionKey));
  }

  async setMain(principal: VerifiedPrincipal, input: SetAgentChoice): Promise<AgentChoiceWrite> {
    return this.set(principal, 'main', input, null);
  }

  private async set(principal: VerifiedPrincipal, scope: 'session' | 'main',
    input: SetAgentChoice, sessionKey: string | null): Promise<AgentChoiceWrite> {
    if ((input.actingSubject !== null && !agentId.test(input.actingSubject))
      || (input.expectedRevision !== null && !uuid.test(input.expectedRevision))
      || !key.test(input.idempotencyKey)) {
      throw new ActingContextInvalid('invalid Agent choice');
    }
    const digest = createHash('sha256').update(JSON.stringify({ scope, sessionKey,
      actingSubject: input.actingSubject, expectedRevision: input.expectedRevision })).digest('hex');
    return transaction(this.pool, async client => {
      const gate = await currentGate(client);
      const principalId = (await client.query<{ id: string }>(`SELECT id FROM access.principal
        WHERE account_issuer = $1 AND account_subject = $2 AND active FOR UPDATE`,
      [principal.issuer, principal.subject])).rows[0]?.id;
      if (!principalId) throw new ActingContextDenied('principal is not admitted');
      const table = scope === 'session' ? 'access.session_agent' : 'access.main_agent_preference';
      const receiptTable = scope === 'session' ? 'access.session_agent_receipt'
        : 'access.main_agent_preference_receipt';
      const sessionPredicate = scope === 'session' ? ' AND session_key = $2' : '';
      const receiptParams = scope === 'session'
        ? [principalId, sessionKey, input.idempotencyKey] : [principalId, input.idempotencyKey];
      const receipt = (await client.query<SavedChoice & { request_digest: string }>(`
        SELECT request_digest, acting_subject, revision FROM ${receiptTable}
        WHERE principal_id = $1${sessionPredicate}
          AND idempotency_key = $${receiptParams.length}`, receiptParams)).rows[0];
      if (receipt) {
        if (receipt.request_digest !== digest) {
          throw new ActingContextStale('Agent choice idempotency key was reused');
        }
        return { profile: scope === 'session' ? 'session-agent-v1' : 'main-agent-preference-v1',
          actingSubject: receipt.acting_subject, revision: receipt.revision, replayed: true };
      }
      const lookupParams = scope === 'session' ? [principalId, sessionKey] : [principalId];
      const prior = (await client.query<SavedChoice>(`SELECT acting_subject, revision FROM ${table}
        WHERE principal_id = $1${sessionPredicate} FOR UPDATE`, lookupParams)).rows[0];
      if ((prior?.revision ?? null) !== input.expectedRevision) {
        throw new ActingContextStale('Agent choice revision changed');
      }
      if (input.actingSubject !== null && (!gate.open || !gate.dispatch_open
        || !(await eligibleSubject(client, principalId, input.actingSubject, principal.emailVerified === true)
          || await directWorkCreateProof(client, principalId, input.actingSubject)))) {
        throw new ActingContextDenied('selected Agent is not eligible');
      }
      const revision = randomUUID();
      const rowParams = scope === 'session'
        ? [principalId, sessionKey, input.actingSubject, revision, input.expectedRevision]
        : [principalId, input.actingSubject, revision, input.expectedRevision];
      const columns = scope === 'session' ? 'principal_id, session_key, acting_subject, revision'
        : 'principal_id, acting_subject, revision';
      const values = scope === 'session' ? '$1,$2,$3,$4' : '$1,$2,$3';
      const expected = rowParams.length;
      const written = await client.query(`INSERT INTO ${table} (${columns}) VALUES (${values})
        ON CONFLICT (principal_id${scope === 'session' ? ', session_key' : ''}) DO UPDATE
          SET acting_subject = EXCLUDED.acting_subject, revision = EXCLUDED.revision
          WHERE ${table}.revision = $${expected}`, rowParams);
      if (written.rowCount !== 1) throw new ActingContextStale('Agent choice revision changed');
      const receiptValues = scope === 'session' ? '$1,$2,$3,$4,$5,$6' : '$1,$2,$3,$4,$5';
      const receiptColumns = scope === 'session'
        ? 'principal_id, session_key, idempotency_key, request_digest, acting_subject, revision'
        : 'principal_id, idempotency_key, request_digest, acting_subject, revision';
      const receiptWrite = scope === 'session'
        ? [principalId, sessionKey, input.idempotencyKey, digest, input.actingSubject, revision]
        : [principalId, input.idempotencyKey, digest, input.actingSubject, revision];
      await client.query(`INSERT INTO ${receiptTable} (${receiptColumns})
        VALUES (${receiptValues})`, receiptWrite);
      return { profile: scope === 'session' ? 'session-agent-v1' : 'main-agent-preference-v1',
        actingSubject: input.actingSubject, revision, replayed: false };
    }, 'READ COMMITTED');
  }
}

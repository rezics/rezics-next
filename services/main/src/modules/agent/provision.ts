import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AccountAssertionDenied, AccountAssertionUnavailable,
  type AccountAssertionVerifier } from '../account/verify-assertion.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { AgentGraphInvalid, AgentGraphPending, compensateAgentGraph, createAgentGraph,
  type AgentGraphIntent, type AgentKind, type AgentGraphReceipt } from './graph.ts';

export class AgentProvisionDenied extends Error {}
export class AgentProvisionConflict extends Error {}
export class AgentProvisionInvalid extends Error {}
export class AgentProvisionUnavailable extends Error {}

export interface AgentProvisionInput { kind: AgentKind; displayName: string }
export interface AgentProvisionResult { profile: 'agent-provision-v1'; operationId: string;
  agent: string; state: 'pending' | 'active' | 'compensating' | 'compensated';
  replayed: boolean; sourcePosition: { dataEpoch: string; sequence: string } | null }

interface ProvisionRow { id: string; principal_id: string; request_digest: string;
  agent_id: string; agent_kind: AgentKind; display_name: string;
  principal_epoch: string; state: 'planned' | 'graph_committed' | 'active'
    | 'compensating' | 'compensated'; graph_data_epoch: string | null;
  graph_sequence: string | null }

export function agentProvisionDigest(input: AgentProvisionInput): string {
  if (!['person', 'organization', 'service'].includes(input.kind)
    || input.displayName.length < 1 || input.displayName.length > 200
    || /[\u0000-\u001f\u007f]/.test(input.displayName)) {
    throw new AgentProvisionInvalid('invalid Agent creation intent');
  }
  return createHash('sha256').update(JSON.stringify({ family: 'agent-provision-v1',
    kind: input.kind, displayName: input.displayName })).digest('hex');
}

function view(row: ProvisionRow, replayed: boolean): AgentProvisionResult {
  return { profile: 'agent-provision-v1', operationId: row.id, agent: row.agent_id,
    state: row.state === 'planned' || row.state === 'graph_committed' ? 'pending' : row.state,
    replayed, sourcePosition: row.graph_data_epoch && row.graph_sequence
      ? { dataEpoch: row.graph_data_epoch, sequence: row.graph_sequence } : null };
}

function graphIntent(row: ProvisionRow): AgentGraphIntent {
  return { id: row.id, agent: row.agent_id, kind: row.agent_kind,
    displayName: row.display_name, digest: row.request_digest };
}

/** The Account exchange is limited to two HTTP calls at 3 seconds each. Each
 * Access step has one indexed principal/key lookup and one row transition;
 * graph creation and compensation each use at most one bounded command and
 * two exact receipt reads. No step scans other principals or Agents. */
export class AgentProvisioning {
  constructor(private readonly pool: Pool, private readonly env: WorkActivationEnvironment) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const fence = await client.query<{ open: boolean }>(
        'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
      if (fence.rows[0]?.open !== true) throw new AgentProvisionUnavailable('Access recovery hold');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      if (error && typeof error === 'object' && 'code' in error
        && ['40001', '40P01', '55P03', '57014'].includes(String(error.code))) {
        throw new AgentProvisionUnavailable('Access write timed out');
      }
      throw error;
    } finally { client.release(); }
  }

  private async stage(principal: VerifiedPrincipal, key: string,
    input: AgentProvisionInput, digest: string): Promise<{ row: ProvisionRow; replayed: boolean }> {
    return this.transaction(async client => {
      await client.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
        VALUES ($1,$2,$3) ON CONFLICT (account_issuer, account_subject) DO NOTHING`,
      [randomUUID(), principal.issuer, principal.subject]);
      const actor = (await client.query<{ id: string; enforcement_epoch: string; active: boolean }>(`
        SELECT id, enforcement_epoch, active FROM access.principal
        WHERE account_issuer = $1 AND account_subject = $2 FOR UPDATE`,
      [principal.issuer, principal.subject])).rows[0];
      if (!actor?.active) throw new AgentProvisionDenied('Account principal is inactive in Access');
      const id = randomUUID();
      await client.query(`INSERT INTO access.agent_provision
        (id, principal_id, idempotency_key, request_digest, agent_id, agent_kind,
         display_name, principal_epoch)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (principal_id, idempotency_key) DO NOTHING`,
      [id, actor.id, key, digest, `https://rezics.com/id/${randomUUID()}`,
        input.kind, input.displayName, actor.enforcement_epoch]);
      const row = (await client.query<ProvisionRow>(`SELECT * FROM access.agent_provision
        WHERE principal_id = $1 AND idempotency_key = $2 FOR UPDATE`, [actor.id, key])).rows[0];
      if (!row) throw new AgentProvisionUnavailable('Agent provision row is unavailable');
      if (row.request_digest !== digest) throw new AgentProvisionConflict('key binds another Agent intent');
      return { row, replayed: row.id !== id };
    });
  }

  private async current(id: string): Promise<ProvisionRow> {
    const result = await this.pool.query<ProvisionRow>(
      'SELECT * FROM access.agent_provision WHERE id = $1', [id]);
    if (!result.rows[0]) throw new AgentProvisionUnavailable('Agent provision row is missing');
    return result.rows[0];
  }

  private async graphCommitted(id: string, receipt: AgentGraphReceipt): Promise<ProvisionRow> {
    return this.transaction(async client => {
      const row = (await client.query<ProvisionRow>(
        'SELECT * FROM access.agent_provision WHERE id = $1 FOR UPDATE', [id])).rows[0]!;
      if (row.state === 'planned') {
        await client.query(`UPDATE access.agent_provision SET state = 'graph_committed',
          graph_data_epoch = $2, graph_sequence = $3 WHERE id = $1`,
        [id, receipt.dataEpoch, receipt.sequence]);
      } else if (row.graph_data_epoch !== receipt.dataEpoch
        || row.graph_sequence !== receipt.sequence) {
        throw new AgentProvisionConflict('graph position differs from saved operation');
      }
      return row.state === 'planned' ? { ...row, state: 'graph_committed',
        graph_data_epoch: receipt.dataEpoch, graph_sequence: receipt.sequence } : row;
    });
  }

  private async activate(id: string): Promise<ProvisionRow> {
    return this.transaction(async client => {
      const row = (await client.query<ProvisionRow>(
        'SELECT * FROM access.agent_provision WHERE id = $1 FOR UPDATE', [id])).rows[0]!;
      if (row.state !== 'graph_committed') return row;
      const actor = (await client.query<{ active: boolean; enforcement_epoch: string }>(`
        SELECT active, enforcement_epoch FROM access.principal WHERE id = $1 FOR SHARE`,
      [row.principal_id])).rows[0];
      if (!actor?.active || actor.enforcement_epoch !== row.principal_epoch) {
        await client.query("UPDATE access.agent_provision SET state = 'compensating' WHERE id = $1", [id]);
        return { ...row, state: 'compensating' };
      }
      const representationId = randomUUID();
      await client.query(`INSERT INTO access.authority_subject (id, kind, active)
        VALUES ($1,'agent',true)`, [row.agent_id]);
      await client.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until, assigned_by_principal)
        VALUES ($1,$2,$3,'agent.control','infinity',$2)`,
      [representationId, row.principal_id, row.agent_id]);
      await client.query(`UPDATE access.agent_provision SET state = 'active',
        representation_id = $2 WHERE id = $1`, [id, representationId]);
      return { ...row, state: 'active' };
    });
  }

  private async compensate(row: ProvisionRow): Promise<ProvisionRow> {
    await this.transaction(async client => {
      await client.query(`UPDATE access.agent_provision SET state = 'compensating'
        WHERE id = $1 AND state IN ('planned', 'graph_committed')`, [row.id]);
    });
    await compensateAgentGraph(this.env, graphIntent(row));
    return this.transaction(async client => {
      const latest = (await client.query<ProvisionRow>(
        'SELECT * FROM access.agent_provision WHERE id = $1 FOR UPDATE', [row.id])).rows[0]!;
      if (latest.state === 'active') throw new AgentProvisionConflict('active Agent cannot be compensated');
      if (latest.state !== 'compensated') {
        await client.query("UPDATE access.agent_provision SET state = 'compensated' WHERE id = $1",
          [row.id]);
      }
      return { ...latest, state: 'compensated' };
    });
  }

  async provision(account: Pick<AccountAssertionVerifier, 'verify'>, request: Request,
    input: AgentProvisionInput, key: string): Promise<AgentProvisionResult> {
    if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) {
      throw new AgentProvisionInvalid('bounded Idempotency-Key is required');
    }
    const digest = agentProvisionDigest(input);
    const principal = await account.verify(request, ['agent:create']);
    const { row, replayed } = await this.stage(principal, key, input, digest);
    if (row.state === 'active' || row.state === 'compensated') return view(row, replayed);
    if (row.state === 'compensating') {
      try { return view(await this.compensate(row), true); }
      catch { return view(row, true); }
    }
    let receipt: AgentGraphReceipt;
    try { receipt = await createAgentGraph(this.env, graphIntent(row)); }
    catch (error) {
      if (error instanceof AgentGraphInvalid) {
        try { return view(await this.compensate(row), replayed); }
        catch { return view(row, replayed); }
      }
      if (error instanceof AgentGraphPending) return view(row, replayed);
      throw error;
    }
    let committed: ProvisionRow;
    try { committed = await this.graphCommitted(row.id, receipt); }
    catch (error) {
      if (error instanceof AgentProvisionConflict) throw error;
      return view(row, replayed);
    }
    try {
      const refreshed = await account.verify(request, ['agent:create']);
      if (refreshed.issuer !== principal.issuer || refreshed.subject !== principal.subject) {
        throw new AccountAssertionDenied('Account principal changed during provision');
      }
    } catch (error) {
      if (error instanceof AccountAssertionUnavailable) return view(committed, replayed);
      if (!(error instanceof AccountAssertionDenied)) return view(committed, replayed);
      try {
        await this.transaction(async client => {
          await client.query(`UPDATE access.agent_provision SET state = 'compensating'
            WHERE id = $1 AND state = 'graph_committed'`, [row.id]);
        });
        return view(await this.compensate(committed), replayed);
      } catch { return view(committed, replayed); }
    }
    try {
      const activated = await this.activate(row.id);
      if (activated.state === 'compensating') {
        try { return view(await this.compensate(activated), replayed); }
        catch { return view(activated, replayed); }
      }
      return view(activated, replayed);
    } catch { return view(await this.current(row.id), replayed); }
  }
}

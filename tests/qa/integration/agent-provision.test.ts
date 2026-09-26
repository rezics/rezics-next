import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { FusekiClient, type CommandEnvelope, type CommandResult }
  from '../../../services/main/src/infrastructure/fuseki.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { agentProvisionHarness } from './agent-provision-support.ts';

const body = (displayName: string) => ({ profile: 'agent-provision-v1',
  kind: 'person' as const, displayName });
type Result = { operationId: string; agent: string; state: string; replayed: boolean;
  sourcePosition: { dataEpoch: string; sequence: string } | null };

test('SYS01: Account OAuth, Access receipt and Main graph create one public Agent without private mapping',
  async () => {
    const h = await agentProvisionHarness();
    try {
      const app = h.main();
      const key = `agent-${randomUUID()}`;
      const denied = await h.call(app, h.wrongScopeToken, `${key}-denied`, body('Denied'));
      expect(denied.status).toBe(401);
      const first = await h.call(app, h.token, key, body('A public person'));
      expect(first.status).toBe(201);
      const created = await first.json() as Result;
      expect(created.state).toBe('active');
      expect(created.sourcePosition?.dataEpoch).toBe(h.env.lineage.dataEpoch);
      const replay = await h.call(app, h.token, key, body('A public person'));
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ agent: created.agent,
        operationId: created.operationId, state: 'active', replayed: true });
      const conflict = await h.call(app, h.token, key, body('Another person'));
      expect(conflict.status).toBe(409);
      const access = await h.accessPool.query<{ principal_id: string; representation_id: string }>(`
        SELECT principal_id, representation_id FROM access.agent_provision WHERE id = $1`,
      [created.operationId]);
      expect(access.rowCount).toBe(1);
      const mandate = await h.accessPool.query<{ action: string }>(`
        SELECT action FROM access.representation WHERE id = $1 AND subject_id = $2`,
      [access.rows[0]!.representation_id, created.agent]);
      expect(mandate.rows[0]?.action).toBe('agent.control');
      const graph = await h.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
        SELECT ?kind ?name WHERE { GRAPH <urn:rezics:graph:current> {
          <${created.agent}> a rv:Agent ; rv:agentKind ?kind ;
            <http://www.w3.org/2000/01/rdf-schema#label> ?name . } }`);
      expect(graph.results?.bindings).toHaveLength(1);
      expect(graph.results?.bindings[0]?.name?.value).toBe('A public person');
      const publicText = JSON.stringify(graph);
      expect(publicText).not.toContain(access.rows[0]!.principal_id);
      expect(publicText).not.toContain(h.user.id);

      const concurrentKey = `agent-${randomUUID()}`;
      const concurrent = await Promise.all([h.call(app, h.token, concurrentKey, body('Concurrent')),
        h.call(app, h.token, concurrentKey, body('Concurrent'))]);
      expect(concurrent.every(response => [200, 201, 202].includes(response.status))).toBe(true);
      const resolved = await h.call(app, h.token, concurrentKey, body('Concurrent'));
      expect(resolved.status).toBe(200);
      const resolvedBody = await resolved.json() as Result;
      expect(resolvedBody.state).toBe('active');
      const count = await h.accessPool.query<{ count: string }>(`
        SELECT count(*)::text AS count FROM access.agent_provision WHERE idempotency_key = $1`,
      [concurrentKey]);
      expect(count.rows[0]?.count).toBe('1');

      // The principal/key receipt lookup must stay bounded as unrelated
      // operations grow. A native plan catches an accidental table scan.
      await h.accessPool.query(`INSERT INTO access.agent_provision
        (id, principal_id, idempotency_key, request_digest, agent_id,
         agent_kind, display_name, principal_epoch)
        SELECT gen_random_uuid(), $1, 'unrelated-agent-' || n,
          repeat('a', 64), 'https://rezics.com/id/' || gen_random_uuid(),
          'person', 'Unrelated', 0 FROM generate_series(1, 1024) n`,
      [access.rows[0]!.principal_id]);
      await h.accessPool.query('ANALYZE access.agent_provision');
      type Plan = { 'Node Type': string; 'Relation Name'?: string;
        'Actual Rows': number; 'Rows Removed by Filter'?: number; Plans?: Plan[] };
      const explained = await h.accessPool.query<{ 'QUERY PLAN': [{ Plan: Plan }] }>(`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF)
        SELECT * FROM access.agent_provision WHERE principal_id = $1
          AND idempotency_key = $2 FOR UPDATE`,
      [access.rows[0]!.principal_id, key]);
      const visited = (node: Plan): number => (node['Relation Name'] === 'agent_provision'
        ? node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0) : 0)
        + (node.Plans ?? []).reduce((sum, child) => sum + visited(child), 0);
      const plan = explained.rows[0]!['QUERY PLAN'][0]!.Plan;
      expect(visited(plan)).toBeLessThanOrEqual(8);
    } finally { await h.close(); }
  }, 120_000);

test('SYS01: a stale Access principal compensates the committed graph Agent and retains receipts',
  async () => {
    const h = await agentProvisionHarness();
    try {
      let advanced = false;
      class StaleAfterGraph extends FusekiClient {
        override async command(envelope: CommandEnvelope): Promise<CommandResult> {
          const result = await super.command(envelope);
          if (!advanced && envelope.receipt.startsWith('urn:rezics:receipt:agent-provision:')
            && result.status === 'committed') {
            advanced = true;
            await h.accessPool.query(`UPDATE access.principal
              SET enforcement_epoch = enforcement_epoch + 1 WHERE account_subject = $1`,
            [h.user.id]);
          }
          return result;
        }
      }
      const faulted = new StaleAfterGraph(Bun.env.FUSEKI_URL!);
      const app = h.main(new AgentProvisioning(h.accessPool, { ...h.env, fuseki: faulted }));
      const key = `agent-stale-${randomUUID()}`;
      const response = await h.call(app, h.token, key, body('Stale person'));
      expect(response.status).toBe(409);
      expect(advanced).toBe(true);
      const row = (await h.accessPool.query<{ agent_id: string; state: string }>(`
        SELECT agent_id, state FROM access.agent_provision WHERE idempotency_key = $1`,
      [key])).rows[0]!;
      expect(row.state).toBe('compensated');
      const authority = await h.accessPool.query(`SELECT 1 FROM access.authority_subject WHERE id = $1`,
        [row.agent_id]);
      expect(authority.rowCount).toBe(0);
      const current = await h.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
        ASK { GRAPH <urn:rezics:graph:current> { <${row.agent_id}> a rv:Agent } }`);
      expect(current.boolean).toBe(false);
      const receipts = await h.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
        SELECT ?r WHERE { GRAPH <urn:rezics:graph:receipts> {
          ?r rv:agent <${row.agent_id}> . } }`);
      expect(receipts.results?.bindings).toHaveLength(1);
      expect((await h.call(app, h.token, key, body('Stale person'))).status).toBe(409);
    } finally { await h.close(); }
  }, 120_000);

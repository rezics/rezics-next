import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { CommandOutcomeUnknown, FusekiClient, type CommandEnvelope, type CommandResult }
  from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccountAssertionUnavailable }
  from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { agentProvisionHarness } from '../integration/agent-provision-support.ts';

const body = { profile: 'agent-provision-v1', kind: 'service', displayName: 'Recovery service' };

test('SYS01: lost graph response and Account pause retain pending state then recover one Agent',
  async () => {
    const h = await agentProvisionHarness();
    try {
      let lost = false;
      class LostGraphReply extends FusekiClient {
        override async command(envelope: CommandEnvelope): Promise<CommandResult> {
          const result = await super.command(envelope);
          if (!lost && envelope.receipt.startsWith('urn:rezics:receipt:agent-provision:')
            && result.status === 'committed') {
            lost = true;
            throw new CommandOutcomeUnknown('injected response loss after real graph commit');
          }
          return result;
        }
      }
      const faulted = new LostGraphReply(Bun.env.FUSEKI_URL!);
      let checks = 0;
      const accountPaused = { verify: async (request: Request, scopes: readonly string[]) => {
        checks++;
        if (checks === 2) throw new AccountAssertionUnavailable('injected Account pause');
        return h.verifier.verify(request, scopes);
      } };
      const key = `agent-recovery-${randomUUID()}`;
      const first = await h.call(h.main(new AgentProvisioning(h.accessPool,
        { ...h.env, fuseki: faulted }), accountPaused), h.token, key, body);
      expect(first.status).toBe(202);
      expect(lost).toBe(true);
      const pending = await first.json() as { agent: string; operationId: string; state: string };
      expect(pending.state).toBe('pending');
      const before = await h.accessPool.query(`SELECT 1 FROM access.authority_subject WHERE id = $1`,
        [pending.agent]);
      expect(before.rowCount).toBe(0);
      const created = await h.call(h.main(), h.token, key, body);
      expect(created.status).toBe(200);
      expect(await created.json()).toMatchObject({ operationId: pending.operationId,
        agent: pending.agent, state: 'active', replayed: true });
      const receipt = await h.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
        SELECT ?sequence WHERE { GRAPH <urn:rezics:graph:receipts> {
          <urn:rezics:receipt:agent-provision:${pending.operationId}>
          rv:sequence ?sequence ; rv:agent <${pending.agent}> . } }`);
      expect(receipt.results?.bindings).toHaveLength(1);
      const representation = await h.accessPool.query<{ count: string }>(`
        SELECT count(*)::text AS count FROM access.representation
        WHERE subject_id = $1 AND action = 'agent.control'`, [pending.agent]);
      expect(representation.rows[0]?.count).toBe('1');
    } finally { await h.close(); }
  }, 120_000);

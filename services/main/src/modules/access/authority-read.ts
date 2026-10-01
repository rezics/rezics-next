import type { Pool } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import { agentPattern, PolicyDenied, PolicyInvalid, uuidPattern } from './policy-errors.ts';
import { inAccessTransaction, requireActivePrincipal, requireGrant, requireMandate,
  requireRecoveryOpen } from './policy-transaction.ts';

export const AUTHORITY_READ_COST = { selectedRows: 5, statements: 10 } as const;

/** A manager's current preconditions, including before the first write creates
 * a resource receipt. No admission is created and no authority is widened. */
export class AccessAuthorityRead {
  constructor(private readonly pool: Pool) {}

  async read(principal: VerifiedPrincipal, input: {
    scopeId: string; actingSubject: string; action: string;
  }) {
    if (!agentPattern.test(input.actingSubject) || !input.scopeId || input.scopeId.length > 256
      || !/^[a-z][a-z0-9.-]{0,127}$/.test(input.action)) {
      throw new PolicyInvalid('invalid authority read');
    }
    return inAccessTransaction(this.pool, 'repeatable read', async client => {
      await requireRecoveryOpen(client, false);
      const identity = await requireActivePrincipal(client, principal);
      const representation = await requireMandate(client, identity.id, input.actingSubject, input.action);
      let grant: { id: string; generation: string } | null = null;
      if (input.action === 'access.representation.manage') {
        if (input.scopeId !== 'access:representation-topology') throw new PolicyDenied('wrong topology scope');
      } else if (input.action === 'work.create') {
        if (input.scopeId !== 'work:create:root') throw new PolicyDenied('wrong Work creation scope');
      } else if (input.action === 'agent.control') {
        if (input.scopeId !== 'work:create:root') {
          const admitted = await client.query(`SELECT 1 FROM access.permission_grant
            WHERE recipient_subject = $1 AND scope_id = $2 AND active
              AND valid_until > clock_timestamp() LIMIT 1`, [input.actingSubject, input.scopeId]);
          if (!admitted.rowCount) throw new PolicyDenied('Agent has no authority in this scope');
        }
      } else if (input.action === 'access.revoke') {
        // Revocation authority belongs to an exact issued source, never an
        // arbitrary scope. Its preconditions are read by revocationSource.
        throw new PolicyInvalid('read the exact revocation source');
      } else {
        grant = await requireGrant(client, input.actingSubject, input.scopeId, input.action);
      }
      const gate = (await client.query<{ authority_epoch: string; group_generation: string }>(
        'SELECT authority_epoch, group_generation FROM access.scope_gate WHERE id = $1',
        [input.scopeId])).rows[0];
      if (!gate) throw new PolicyDenied('scope is unavailable');
      return { scopeId: input.scopeId, actingSubject: input.actingSubject, action: input.action,
        authorityEpoch: gate.authority_epoch, groupGeneration: gate.group_generation,
        representation, grant };
    });
  }

  /** A source the issuer retained from its creation, under the same current
   * mandate required by revocation. Exact primary-key lookup bounds history cost. */
  async revocationSource(principal: VerifiedPrincipal, input: {
    sourceId: string; issuerSubject: string;
  }) {
    if (!agentPattern.test(input.issuerSubject) || !uuidPattern.test(input.sourceId)) {
      throw new PolicyInvalid('invalid revocation source read');
    }
    return inAccessTransaction(this.pool, 'repeatable read', async client => {
      await requireRecoveryOpen(client, false);
      const identity = await requireActivePrincipal(client, principal);
      await requireMandate(client, identity.id, input.issuerSubject, 'access.revoke');
      const source = (await client.query<{ id: string; generation: string; action: string;
        recipient_subject: string; active: boolean; scope_id: string; authority_epoch: string }>(`
        SELECT p.id, p.generation, p.action, p.recipient_subject, p.active, p.scope_id, g.authority_epoch
        FROM access.permission_grant p JOIN access.scope_gate g ON g.id = p.scope_id
        WHERE p.id = $1 AND p.issuer_subject = $2`, [input.sourceId, input.issuerSubject])).rows[0];
      if (!source) throw new PolicyDenied('source is unavailable to issuer');
      return { scopeId: source.scope_id, authorityEpoch: source.authority_epoch,
        source: { id: source.id, generation: source.generation, action: source.action,
          recipientSubject: source.recipient_subject, active: source.active } };
    });
  }
}

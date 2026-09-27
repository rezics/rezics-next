import type { Pool } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { inAccessTransaction, requireRecoveryOpen } from '../access/policy-transaction.ts';

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const MAX_RESOURCES = 65;

/** One current Access decision for a bounded summary batch. The predicates and
 * row locks mirror AccessAdmissionRegistry.canReadWork; no grant is cached. */
export class MediaAccessBatchReader {
  constructor(private readonly pool: Pool) {}

  async canReadWorks(principal: VerifiedPrincipal, actingSubject: string,
    works: readonly string[]): Promise<Set<string>> {
    return this.canReadScopedResources(principal, actingSubject, works, 'work:read:', 'work.read');
  }

  async canReadSemantics(principal: VerifiedPrincipal, actingSubject: string,
    resources: readonly string[]): Promise<Set<string>> {
    return this.canReadScopedResources(principal, actingSubject, resources, 'semantic:read:', 'semantic.read');
  }

  async canReadPrivateContexts(principal: VerifiedPrincipal, actingSubject: string,
    contexts: readonly string[]): Promise<Set<string>> {
    return this.canReadScopedResources(principal, actingSubject, contexts, 'context:read:', 'context.read');
  }

  private async canReadScopedResources(principal: VerifiedPrincipal, actingSubject: string,
    resources: readonly string[], prefix: string, action: string): Promise<Set<string>> {
    if (!nativeId.test(actingSubject) || resources.length > MAX_RESOURCES
      || resources.some(resource => !nativeId.test(resource))) return new Set();
    const unique = [...new Set(resources)];
    if (!unique.length) return new Set();
    return inAccessTransaction(this.pool, 'read committed', async client => {
      await requireRecoveryOpen(client, true);
      const rows = await client.query<{ resource: string }>(`SELECT wanted.resource
        FROM unnest($3::text[]) AS wanted(resource)
        JOIN access.scope_gate AS gate
          ON gate.id = $5 || wanted.resource AND gate.open
        JOIN access.principal AS principal
          ON principal.account_issuer = $1 AND principal.account_subject = $2 AND principal.active
        JOIN access.authority_subject AS subject ON subject.id = $4 AND subject.active
        JOIN LATERAL (SELECT id FROM access.representation
          WHERE principal_id = principal.id AND subject_id = subject.id
            AND action = $6 AND active AND valid_until > clock_timestamp()
          ORDER BY id LIMIT 1 FOR SHARE) AS represented ON true
        JOIN LATERAL (SELECT id FROM access.permission_grant
          WHERE recipient_subject = subject.id AND scope_id = gate.id
            AND action = $6 AND active AND valid_until > clock_timestamp()
          ORDER BY id LIMIT 1 FOR SHARE) AS granted ON true
        FOR SHARE OF gate, principal, subject`,
      [principal.issuer, principal.subject, unique, actingSubject, prefix, action]);
      return new Set(rows.rows.map(row => row.resource));
    });
  }
}

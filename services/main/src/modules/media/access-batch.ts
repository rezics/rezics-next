import type { Pool } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { inAccessTransaction, requireRecoveryOpen } from '../access/policy-transaction.ts';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { authorWorkGeneration } from '../access/author-baseline.ts';
import { baselineMemberProof } from '../access/baseline.ts';
import { readSemanticDisclosure, type SemanticDisclosure } from '../access/semantic-disclosure.ts';

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const MAX_RESOURCES = 65;

/** One Access transaction for at most 65 resources. Explicit grants use one
 * indexed batch query; author fallback uses one live receipt ASK per remaining
 * Work, bounded by 65. No grant is cached. */
export class MediaAccessBatchReader {
  constructor(private readonly pool: Pool, private readonly graph?: Pick<FusekiClient, 'query'>) {}

  async canReadWorks(principal: VerifiedPrincipal, actingSubject: string,
    works: readonly string[]): Promise<Set<string>> {
    return this.canReadScopedResources(principal, actingSubject, works, 'work:read:', 'work.read');
  }

  async canReadSemantics(principal: VerifiedPrincipal | null, actingSubject: string | null,
    resources: readonly string[], graph = this.graph): Promise<SemanticDisclosure | ReadonlySet<string>> {
    return readSemanticDisclosure({ pool: this.pool, graph }, principal, actingSubject, resources);
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
      const allowed = new Set(rows.rows.map(row => row.resource));
      if (action === 'work.read' && principal.emailVerified && this.graph) {
        const actor = (await client.query<{ id: string }>(`SELECT id FROM access.principal
          WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
        [principal.issuer, principal.subject])).rows[0];
        if (actor && await baselineMemberProof(client, actor.id, actingSubject)) {
          const gates = (await client.query<{ id: string; open: boolean }>(`SELECT id, open
            FROM access.scope_gate WHERE id = ANY($1::text[]) FOR SHARE`,
          [unique.map(work => `work:read:${work}`)])).rows;
          const gateById = new Map(gates.map(gate => [gate.id, gate.open]));
          for (const work of unique) {
            if (allowed.has(work) || gateById.get(`work:read:${work}`) === false) continue;
            if (await authorWorkGeneration(client, this.graph, actor.id, actingSubject, work) !== null) {
              allowed.add(work);
            }
          }
        }
      }
      return allowed;
    });
  }
}

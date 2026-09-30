import type { Pool, PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import type { VerifiedPrincipal } from './admission.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { publicWork } from '../work/public-patterns.ts';
import { SEMANTIC_TERMS } from '../semantic/schema.ts';
import { inAccessTransaction, requireRecoveryOpen } from './policy-transaction.ts';

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
export const SEMANTIC_DISCLOSURE_LIMIT = 65;
export interface SemanticDisclosureClient {
  pool: Pool;
  graph?: Pick<FusekiClient, 'query'>;
}
export interface SemanticDisclosure {
  public: ReadonlySet<string>;
  granted: ReadonlySet<string>;
}

/** A semantic editor may restrict or unrestrict that same resource. Reuse the existing edit
 * mandate/grant as the policy revision's durable publication basis. */
export async function semanticPolicyAuthority(client: PoolClient, principalId: string,
  actor: string, scope: string) {
  const resource = scope.startsWith('semantic:read:') ? scope.slice('semantic:read:'.length) : '';
  if (!nativeId.test(resource)) return null;
  const row = (await client.query<{ mandate: string; mandate_generation: string;
    grant: string; grant_generation: string }>(`SELECT represented.id AS mandate,
      represented.generation AS mandate_generation, granted.id AS grant,
      granted.generation AS grant_generation
    FROM access.scope_gate gate JOIN access.authority_subject subject ON subject.id = $2 AND subject.active
    JOIN LATERAL (SELECT id, generation FROM access.representation
      WHERE principal_id = $1 AND subject_id = subject.id AND action = 'semantic.change'
        AND active AND valid_until > clock_timestamp() ORDER BY id LIMIT 1 FOR SHARE) represented ON true
    JOIN LATERAL (SELECT id, generation FROM access.permission_grant
      WHERE recipient_subject = subject.id AND scope_id = gate.id AND action = 'semantic.change'
        AND active AND valid_until > clock_timestamp() ORDER BY id LIMIT 1 FOR SHARE) granted ON true
    WHERE gate.id = $3 AND gate.open FOR SHARE OF gate, subject`,
  [principalId, actor, `semantic:edit:${resource}`])).rows[0];
  return row ? { mandate: { id: row.mandate, generation: row.mandate_generation },
    grant: { id: row.grant, generation: row.grant_generation } } : null;
}

function checkedRefs(refs: readonly string[]) {
  if (refs.length > SEMANTIC_DISCLOSURE_LIMIT || refs.some(ref => !nativeId.test(ref))) {
    throw new RangeError('semantic disclosure batch exceeds its profile');
  }
  return [...new Set(refs)];
}

/** Access owns public semantic disclosure. At most 65 exact resources, one
 * bounded Jena query (65 rows / 32 KiB) and one indexed policy/gate lookup.
 * EXISTS keeps multiple Work links from multiplying the result population.
 * Only the current committed active head qualifies, never staging or history. */
export async function publicSemantics(client: SemanticDisclosureClient, refs: readonly string[],
  revision?: string): Promise<ReadonlySet<string>> {
  const unique = checkedRefs(refs);
  if (!unique.length || !client.graph || (revision !== undefined && !nativeId.test(revision))) return new Set();
  return inAccessTransaction(client.pool, 'read committed', async access => {
    await requireRecoveryOpen(access, true);
    return publicInTransaction(access, client.graph!, unique, revision);
  });
}

async function publicInTransaction(access: PoolClient, graph: Pick<FusekiClient, 'query'>,
  refs: readonly string[], revision?: string): Promise<ReadonlySet<string>> {
  const rows = (await graph.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?resource WHERE {
      VALUES ?resource { ${refs.map(iri).join(' ')} }
      {
        GRAPH ${iri(GRAPHS.current)} { ?resource rv:semanticHead ?head . }
        GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:SemanticRevision . }
        FILTER EXISTS {
          GRAPH ${iri(GRAPHS.current)} { ?resource <${SEMANTIC_TERMS.semanticWork}> ?work . }
          ${publicWork('?work', '?main')}
        }
      } UNION {
        # Relation definitions are public vocabulary; other resources still need a public Work.
        GRAPH ${iri(GRAPHS.current)} { ?resource a rv:SemanticDefinition ;
          rv:definitionKind rv:RelationDefinition ; rv:definitionHead ?head . }
        GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:DefinitionRevision ;
          rv:definitionKind rv:RelationDefinition . }
      }
      GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:RevisionAnchor ;
        rv:component ?resource ; rv:lifecycle rv:Active ; rv:sequence ?sequence . }
      ${revision ? `FILTER(?head = ${iri(revision)})` : ''}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:ErasedRevision } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?resource rv:protectionHead ?protection } }
      # A Work's own description never discloses the Work: Work disclosure has its own owner.
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?resource a schema:CreativeWork } }
    } LIMIT ${refs.length + 1}`, 32_768)).results?.bindings ?? [];
  const candidates = rows.map(row => row.resource?.value);
  if (candidates.length > refs.length || candidates.some(ref => !ref || !refs.includes(ref))
    || new Set(candidates).size !== candidates.length) throw new Error('semantic disclosure result is ambiguous');
  // A missing gate is unrestricted; only an explicit strong closure denies.
  const allowed = await access.query<{ resource: string }>(`SELECT wanted.resource
    FROM unnest($1::text[]) AS wanted(resource)
    WHERE NOT EXISTS (SELECT 1 FROM access.scope_gate
      WHERE id = 'semantic:read:' || wanted.resource AND NOT open)
      AND NOT EXISTS (SELECT 1 FROM access.policy
        WHERE scope_id = 'semantic:read:' || wanted.resource AND ended_at IS NULL)`, [candidates]);
  return new Set(allowed.rows.map(row => row.resource));
}

/** Public and explicit-grant outcomes stay separate so summaries cannot label a
 * granted restriction public. The private path uses one indexed batch query;
 * relation vocabulary is the sole type exception to the public Work link;
 * containers, Contexts and other semantic types supply no read authority. */
export async function readSemanticDisclosure(client: SemanticDisclosureClient,
  principal: VerifiedPrincipal | null, actor: string | null, refs: readonly string[]): Promise<SemanticDisclosure> {
  const unique = checkedRefs(refs);
  if (!unique.length) return { public: new Set(), granted: new Set() };
  return inAccessTransaction(client.pool, 'read committed', async access => {
    await requireRecoveryOpen(access, true);
    const publicRefs = client.graph ? await publicInTransaction(access, client.graph, unique) : new Set<string>();
    if (!principal || !actor || !nativeId.test(actor)) return { public: publicRefs, granted: new Set() };
    const rows = await access.query<{ resource: string }>(`SELECT wanted.resource
      FROM unnest($3::text[]) AS wanted(resource)
      JOIN access.scope_gate gate ON gate.id = 'semantic:read:' || wanted.resource AND gate.open
      JOIN access.principal principal ON principal.account_issuer = $1
        AND principal.account_subject = $2 AND principal.active
      JOIN access.authority_subject subject ON subject.id = $4 AND subject.active
      JOIN LATERAL (SELECT id FROM access.representation WHERE principal_id = principal.id
        AND subject_id = subject.id AND action = 'semantic.read' AND active
        AND valid_until > clock_timestamp() ORDER BY id LIMIT 1 FOR SHARE) represented ON true
      JOIN LATERAL (SELECT id FROM access.permission_grant WHERE recipient_subject = subject.id
        AND scope_id = gate.id AND action = 'semantic.read' AND active
        AND valid_until > clock_timestamp() ORDER BY id LIMIT 1 FOR SHARE) granted ON true
      FOR SHARE OF gate, principal, subject`, [principal.issuer, principal.subject, unique, actor]);
    return { public: publicRefs, granted: new Set(rows.rows.map(row => row.resource)) };
  });
}

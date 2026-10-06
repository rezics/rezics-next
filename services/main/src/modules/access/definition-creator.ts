import type { PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { GRAPHS, iri } from '../work/activate.ts';

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Creation records the steward Agent, whose current controller may manage the
 * definition, never review it by this proof. One exact
 * graph lookup (4 KiB, two rows) and four indexed admission/controller lookups. The caller
 * also needs the live baseline controller proof; neither a readable definition
 * nor an unsealed dispatch establishes ownership. No permission-grant fan-out. */
export async function definitionCreatorAllowed(
  client: Pick<PoolClient, 'query'>,
  graph: Pick<FusekiClient, 'query'> | undefined,
  principal: string,
  actor: string,
  definition: string,
): Promise<boolean> {
  if (!graph || !uuid.test(principal) || !native.test(actor) || !native.test(definition))
    return false;
  const rows =
    (
      await graph.query(
        `PREFIX rv: <https://rezics.com/vocab/>
    SELECT ?admission ?receipt ?digest WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(definition)} a rv:SemanticDefinition ; rv:definitionHead ?head . }
      GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:DefinitionRevision ; rv:component ${iri(definition)} ; rv:lifecycle rv:Active . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(definition)} rv:protectionHead ?protection } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:ErasedRevision } }
      GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:component ${iri(definition)} ; rv:revision ?first ;
        rv:admittedScope "semantic:create:root" ; rv:admissionId ?admission ;
        rv:requestDigest ?digest ; rv:outcome rv:Succeeded . }
      GRAPH ${iri(GRAPHS.revisions)} { ?first a rv:DefinitionRevision ; rv:component ${iri(definition)} . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?first rv:predecessor ?predecessor } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:expectedHead ?expected } }
    } LIMIT 2`,
        4096,
      )
    ).results?.bindings ?? [];
  if (rows.length !== 1) return false;
  const row = rows[0]!;
  if (
    !row.admission ||
    !uuid.test(row.admission.value) ||
    !row.receipt ||
    !/^urn:rezics:receipt:[0-9a-f]{64}$/.test(row.receipt.value) ||
    !row.digest ||
    !/^[0-9a-f]{64}$/.test(row.digest.value)
  )
    return false;
  return (
    (
      await client.query(
        `SELECT a.id FROM access.admission a
    JOIN access.representation r ON r.subject_id = a.acting_subject AND r.principal_id = $2
    JOIN access.principal p ON p.id = r.principal_id AND p.active
    JOIN access.authority_subject s ON s.id = r.subject_id AND s.active AND s.kind = 'agent'
    WHERE a.id = $1 AND a.acting_subject = $3
      AND a.action = 'semantic.change' AND a.scope_id = 'semantic:create:root'
      AND a.state = 'sealed' AND a.graph_outcome = 'succeeded'
      AND a.graph_receipt = $4 AND a.request_digest = $5
      AND r.action = 'agent.control' AND r.active AND r.valid_until > clock_timestamp()
    ORDER BY r.id LIMIT 1 FOR SHARE OF a, r, p, s`,
        [row.admission.value, principal, actor, row.receipt.value, row.digest.value],
      )
    ).rowCount === 1
  );
}

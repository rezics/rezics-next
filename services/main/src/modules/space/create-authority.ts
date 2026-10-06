import type { PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { GRAPHS, iri } from '../work/activate.ts';

/** Zone stewardship follows the exact successful Space creation and live Agent
 * control. One bounded graph lookup plus one admission/control lookup; neither
 * public readability nor Realm membership establishes this authority. */
export async function zoneSpaceCreatorAllowed(client: Pick<PoolClient, 'query'>,
  graph: Pick<FusekiClient, 'query'> | undefined, principal: string, actor: string, target: string) {
  if (!graph) return false;
  const rows = (await graph.query(`PREFIX rv: <https://rezics.com/vocab/>
    SELECT ?admission ?receipt ?digest WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        { BIND(${iri(target)} AS ?zone) ?zone a rv:Zone ; rv:space ?space }
        UNION { BIND(${iri(target)} AS ?space) ?space rv:zoneCapability ?zone }
        ?space a rv:Space ; rv:owner ${iri(actor)} ; rv:zoneCapability ?zone .
        ?zone a rv:Zone ; rv:space ?space .
        FILTER NOT EXISTS { ?space rv:protectionHead ?spaceProtection }
        FILTER NOT EXISTS { ?zone rv:protectionHead ?zoneProtection }
      }
      GRAPH ${iri(GRAPHS.receipts)} { ?receipt a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
        rv:admittedScope "space:create:root" ; rv:space ?space ; rv:zone ?zone ;
        rv:owner ${iri(actor)} ; rv:admissionId ?admission ; rv:requestDigest ?digest . }
    } LIMIT 2`, 4096)).results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !row?.admission || !/^[0-9a-f-]{36}$/.test(row.admission.value)
    || !row.receipt || !/^urn:rezics:receipt:[0-9a-f]{64}$/.test(row.receipt.value)
    || !row.digest || !/^[0-9a-f]{64}$/.test(row.digest.value)) return false;
  return (await client.query(`SELECT a.id FROM access.admission a
    JOIN access.representation r ON r.principal_id = $2 AND r.subject_id = a.acting_subject
    JOIN access.principal p ON p.id = r.principal_id AND p.active
    JOIN access.authority_subject s ON s.id = r.subject_id
    WHERE a.id = $1 AND a.acting_subject = $3
      AND a.action = 'space.create' AND a.scope_id = 'space:create:root'
      AND a.state = 'sealed' AND a.graph_outcome = 'succeeded'
      AND a.graph_receipt = $4 AND a.request_digest = $5
      AND r.action = 'agent.control' AND r.active AND r.valid_until > clock_timestamp()
      AND s.kind = 'agent' AND s.active
    ORDER BY r.id LIMIT 1 FOR SHARE OF a, r, p, s`,
  [row.admission.value, principal, actor, row.receipt.value, row.digest.value])).rowCount === 1;
}

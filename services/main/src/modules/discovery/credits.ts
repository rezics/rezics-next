import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { DISCOVERY_COST, type ProjectedWork } from './contract.ts';

/** Native credit order, not IRI order. External references have no Agent/name
 * authority; retain the Work credit contract's explicit nulls. One bounded query. */
export async function primaryDiscoveryCredits(session: WorkReadSession, work: string): Promise<ProjectedWork['primaryCredits']> {
  const rows = await session.query(`SELECT ?id ?key ?ordinal WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?id a rv:AuthorCredit ; rv:work ${iri(work)} ;
      rv:creditRevision ?revision ; schema:roleName "author" ; rv:externalProvider "open-library" ;
      rv:externalNamespace "author" ; rv:externalKey ?key ; schema:position ?ordinal ; rv:editControl rv:HumanConfirmed . }
    GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:AuthorCreditRevision ; rv:component ?id ;
      rv:work ${iri(work)} ; rv:externalKey ?key ; schema:position ?ordinal .
      FILTER NOT EXISTS { ?revision a rv:ErasedRevision } }
  } ORDER BY ?ordinal STR(?id) LIMIT ${DISCOVERY_COST.primaryCredits}`, DISCOVERY_COST.primaryCredits);
  if (rows.some(row => !row.id || !row.key || !/^\d+$/.test(row.ordinal?.value ?? '')
    || !Number.isSafeInteger(Number(row.ordinal?.value)))
    || new Set(rows.map(row => row.id!.value)).size !== rows.length) {
    throw new WorkReadUnavailable('Discovery credits are ambiguous');
  }
  return rows.map(row => ({ id: row.id!.value, role: 'author', participantKind: 'external-reference',
    provider: 'open-library', key: row.key!.value, ordinal: Number(row.ordinal!.value),
    agent: null, displayName: null, handle: null }));
}

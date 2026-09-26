import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';

/** Current, public Realm names from their owning Space. One graph read for a bounded batch. */
export async function readPublicRealmNames(env: WorkActivationEnvironment,
  realms: readonly string[]): Promise<Map<string, string>> {
  if (!realms.length) return new Map();
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?realm ?name WHERE {
      VALUES ?realm { ${realms.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} {
        ?realm a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
        ?space a rv:Space ; rv:disclosure rv:Public ; rv:realmCapability ?realm ; rdfs:label ?name .
      }
    } LIMIT ${realms.length + 1}`)).results?.bindings ?? [];
  if (rows.length > realms.length) throw new Error('Realm summary read is ambiguous');
  const names = new Map<string, string>();
  for (const row of rows) {
    if (!row.realm || !row.name || names.has(row.realm.value)) {
      throw new Error('Realm summary read is incomplete');
    }
    names.set(row.realm.value, row.name.value);
  }
  return names;
}

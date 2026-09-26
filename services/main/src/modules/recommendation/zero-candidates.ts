import { DATASET, GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';

export async function graphZeroSnapshot(env: WorkActivationEnvironment): Promise<string> {
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?sequence ;
      rv:dataEpoch ${JSON.stringify(env.lineage.dataEpoch)} . }
  }`)).results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.sequence?.value) throw new Error('graph sequence is unavailable');
  return rows[0].sequence.value;
}

/** Current native Works present at the pinned graph sequence, ordered for the zero-score tail. */
export function graphZeroCandidates(env: WorkActivationEnvironment) {
  return async (after: string | null, snapshotTarget: string, limit: number): Promise<string[]> => {
    await assertGraphAdmissionOpen(env.fuseki, env.lineage);
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
      PREFIX schema: <https://schema.org/>
      SELECT ?work WHERE {
        GRAPH ${iri(GRAPHS.current)} { ?work a schema:CreativeWork . }
        FILTER(STRSTARTS(STR(?work), "https://rezics.com/id/"))
        FILTER EXISTS { GRAPH ${iri(GRAPHS.revisions)} {
          ?revision rv:component ?work ; rv:dataEpoch ${JSON.stringify(env.lineage.dataEpoch)} ;
            rv:sequence ?sequence .
          FILTER(?sequence <= ${BigInt(snapshotTarget).toString()})
        } }
        ${after ? `FILTER(STR(?work) > ${JSON.stringify(after)})` : ''}
      } ORDER BY STR(?work) LIMIT ${limit}`)).results?.bindings ?? [];
    return rows.map(row => row.work?.value).filter((value): value is string => !!value);
  };
}

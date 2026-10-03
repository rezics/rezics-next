import type { Pool, PoolClient } from 'pg';
import { GRAPHS, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { publicWork } from '../work/public-patterns.ts';
import { controlTransaction } from '../access/topology-control.ts';

/** Update the changed Work set before publishing its projection frontier.
 * One Work-keyed graph batch; one indexed score/history update per changed
 * Work. Interactive readers seek the admitted score index, never rejected raw
 * scores. Governance/scope changes update that same index transactionally. */
export async function refreshReadRankingAdmissions(env: WorkActivationEnvironment,
  access: Pool, requested: readonly string[], transaction?: PoolClient) {
  const works = [...new Set(requested)];
  if (!works.length) return;
  const rows = (await env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> PREFIX schema: <https://schema.org/>
    SELECT DISTINCT ?work ?main ?head ?realm WHERE {
      VALUES ?work { ${works.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?work rv:head ?head ; rv:mainVersion ?main . }
      ${publicWork('?work','?main')}
      OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?slot a rv:RealmPublicationSlot ; rv:work ?work ; rv:realm ?realm ;
          rv:mainVersion ?main ; rv:selectionHead ?selection .
          ?realm a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
          ?space a rv:Space ; rv:realmCapability ?realm ; rv:disclosure rv:Public .
          FILTER NOT EXISTS { ?space rv:disclosure rv:Private }
          FILTER NOT EXISTS { ?realm rv:protectionHead ?protection } }
        GRAPH ${iri(GRAPHS.revisions)} { ?selection a rv:PublicationSelection ; rv:work ?work ; rv:mainVersion ?main ;
          rv:contribution ?contribution ; rv:publicationDecision ?decision ; rv:selectedDraft ?draft .
          ?decision rv:disclosure rv:Public . FILTER NOT EXISTS { ?draft a rv:ErasedRevision } }
        GRAPH ${iri(GRAPHS.current)} { ?contribution rv:publicationHead ?decision } }
    }`, 512*1024)).results?.bindings ?? [];
  const update = async (client: PoolClient) => {
    await client.query('DELETE FROM access.read_ranking_admission WHERE work=ANY($1::text[])', [works]);
    const admitted = rows.flatMap(row => row.work && row.main && row.head ? [
      { work: row.work.value, head: row.head.value, main_version: row.main.value, context: 'urn:rezics:context:global' },
      ...(row.realm ? [{ work: row.work.value,head: row.head.value,main_version: row.main.value,context: row.realm.value }] : []),
    ] : []);
    if (admitted.length) await client.query(`INSERT INTO access.read_ranking_admission
      SELECT DISTINCT work,context,head,main_version FROM jsonb_to_recordset($1::jsonb)
        AS x(work text,head text,main_version text,context text) ON CONFLICT DO NOTHING`, [JSON.stringify(admitted)]);
    for (const work of works) await client.query('SELECT access.refresh_read_ranking_admission($1)', [work]);
  };
  if (transaction) await update(transaction); else await controlTransaction(access,update);
}

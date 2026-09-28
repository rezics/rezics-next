import type { PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { unerased } from '../work/public-patterns.ts';

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

/** The sealed Work or chapter creation receipt and live maintainer set must agree. The
 * set lock orders this proof with transfers; a transfer back cannot revive a
 * saved generation. A chapter is itself a Work: referencing somebody else's
 * chapter in a composition never confers editing rights over that chapter.
 * Cost: three indexed singleton lookups and one 1 KiB ASK, independent of the
 * author's library size. No materialized per-resource permission grants. */
export async function authorWorkGeneration(client: PoolClient,
  graph: Pick<FusekiClient, 'query'> | undefined, principal: string, actor: string,
  work: string): Promise<string | null> {
  if (!graph || !native.test(work) || !native.test(actor)) return null;
  const row = (await client.query<{ generation: string; main_version: string; action: string; scope_id: string;
    creation_admission: string; graph_receipt: string; request_digest: string }>(`
    SELECT s.generation::text,s.main_version,s.creation_admission,a.graph_receipt,a.request_digest,a.action,a.scope_id
    FROM access.work_maintainer_set s
    JOIN access.work_maintainer m ON m.work = s.work AND m.agent = $3
    JOIN access.admission a ON a.id = s.creation_admission
    WHERE s.work = $1 AND a.principal_id = $2 AND a.acting_subject = $3
      AND ((a.action = 'work.create' AND a.scope_id = 'work:create:root')
        OR (a.action = 'work.edit' AND a.scope_id LIKE 'work:edit:https://rezics.com/id/%'))
      AND a.state = 'sealed' AND a.graph_outcome = 'succeeded'
    FOR SHARE OF s`, [work, principal, actor])).rows[0];
  if (!row) return null;
  const allowed = await graph.query(`PREFIX rv: <https://rezics.com/vocab/>
    PREFIX schema: <https://schema.org/> ASK {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(work)} a schema:CreativeWork ; rv:head ?head ; rv:mainVersion ${iri(row.main_version)}
          ${row.action === 'work.edit' ? `; schema:isPartOf ${iri(row.scope_id.slice('work:edit:'.length))}` : ''} .
      }
      ${unerased(iri(work))}
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(row.graph_receipt)} ${row.action === 'work.create' ? 'rv:work' : 'rv:chapterWork'} ${iri(work)} ;
          ${row.action === 'work.create' ? 'rv:mainVersion' : 'rv:chapterMainVersion'} ${iri(row.main_version)} ;
          rv:admissionId ${lit(row.creation_admission)} ; rv:requestDigest ${lit(row.request_digest)} ;
          rv:admittedScope ${lit(row.scope_id)} ; rv:outcome rv:Succeeded .
      }
    }`, 1024);
  return allowed.boolean === true ? row.generation : null;
}

/** One bounded candidate query and indexed transfer probes. Realm membership,
 * bans and review policy remain enforced by the ordinary participation guard.
 * Public contributions on another author's Work retain their own authorship;
 * a creator who transferred their Work cannot reuse their former baseline. */
export async function authorSubmissionProof(client: PoolClient,
  graph: Pick<FusekiClient, 'query'> | undefined, principal: string, actor: string,
  realm: string, contribution: string | null): Promise<{ work: string; generation: string | null } | null> {
  if (!graph || !contribution || !native.test(contribution)) return null;
  // Whole-Work and Content offers pass their Work as the baseline target. The
  // owner validates the exact publication separately; a public Work alone is
  // insufficient, and transfer generations are pinned by the baseline receipt.
  const generation = await authorWorkGeneration(client, graph, principal, actor, contribution);
  if (generation !== null) return { work: contribution, generation };
  const rows = (await graph.query(`PREFIX rv: <https://rezics.com/vocab/>
    PREFIX schema: <https://schema.org/> SELECT ?work WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(realm)} a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
        ?space rv:realmCapability ${iri(realm)} .
        ${iri(contribution)} a rv:TextContribution ; rv:author ${iri(actor)} ;
          rv:work ?work ; rv:publicationHead ?publication .
        ?work a schema:CreativeWork ; rv:head ?head .
        FILTER NOT EXISTS { ${iri(contribution)} rv:protectionHead ?protection }
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ?publication a rv:PublicationDecision ; rv:component ${iri(contribution)} ; rv:work ?work ;
          rv:disclosure rv:Public ; rv:rightsBasis rv:OriginalContribution ; rv:selectedDraft ?draft .
        FILTER NOT EXISTS { ?draft a rv:ErasedRevision }
      }
      ${unerased('?work')}
    } LIMIT 2`, 2048)).results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.work?.value) return null;
  const work = rows[0].work.value;
  const created = (await client.query<{ generation: string; acting_subject: string }>(`
    SELECT s.generation::text,a.acting_subject FROM access.work_maintainer_set s
    JOIN access.admission a ON a.id = s.creation_admission
    WHERE s.work = $1 FOR SHARE OF s`, [work])).rows[0];
  if (created?.acting_subject === actor
    && await authorWorkGeneration(client, graph, principal, actor, work) === null) return null;
  return { work, generation: created?.generation ?? null };
}

/** Withdrawal is owned by the submitter recorded in Access, even if the
 * publication subsequently moves. One indexed submission lookup. */
export async function authorWithdrawalProof(client: PoolClient, actor: string,
  realm: string, submission: string | null): Promise<string | null> {
  if (!submission || !native.test(submission)) return null;
  const row = (await client.query<{ work: string }>(`SELECT work FROM access.realm_submission
    WHERE id = $1 AND realm = $2 AND submitting_agent = $3
      AND state IN ('pending', 'changes-requested') FOR SHARE`,
  [submission.slice(-36), realm, actor])).rows[0];
  return row?.work ?? null;
}

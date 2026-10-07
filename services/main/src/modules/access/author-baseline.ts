import type { PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { unerased } from '../work/public-patterns.ts';

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const MAX_AUTHOR_WORKS = 65;
const AUTHOR_PROOF_BYTES = 16_384;

interface AuthorWorkCandidate {
  resource: string;
  generation: string;
  main_version: string;
  action: string;
  scope_id: string;
  creation_admission: string;
  graph_receipt: string;
  request_digest: string;
}

/** The lateral singleton keeps multiple controller mandates from multiplying
 * candidates. Exact Work keys bound both the lookup and the locked set. Lock
 * membership too: after waiting behind a transfer, an unmarked join row could
 * otherwise retain the former maintainer from the statement snapshot. */
async function authorWorkCandidates(client: PoolClient, principal: string, actor: string,
  works: string | readonly string[]): Promise<AuthorWorkCandidate[]> {
  return (await client.query<AuthorWorkCandidate>(`
    SELECT wanted.work AS resource, proof.*
    FROM unnest(${typeof works === 'string' ? 'ARRAY[$1::text]' : '$1::text[]'}) AS wanted(work)
    JOIN LATERAL (
      SELECT s.generation::text,s.main_version,s.creation_admission,a.graph_receipt,a.request_digest,a.action,a.scope_id
      FROM access.work_maintainer_set s
      JOIN access.work_maintainer m ON m.work = s.work AND m.agent = $3
      JOIN access.admission a ON a.id = s.creation_admission
      JOIN access.representation r ON r.subject_id = m.agent AND r.principal_id = $2
      JOIN access.principal p ON p.id = r.principal_id AND p.active
      JOIN access.authority_subject agent ON agent.id = m.agent AND agent.active AND agent.kind = 'agent'
      WHERE s.work = wanted.work AND r.action = 'agent.control' AND r.active AND r.valid_until > clock_timestamp()
        AND ((a.action = 'work.create' AND a.scope_id = 'work:create:root')
          OR (a.action = 'work.edit' AND a.scope_id LIKE 'work:edit:https://rezics.com/id/%'))
        AND a.state = 'sealed' AND a.graph_outcome = 'succeeded'
      ORDER BY r.id LIMIT 1 FOR SHARE OF s, m, r, p, agent
    ) AS proof ON true`, [works, principal, actor])).rows;
}

// Singleton admissions and batch readers use the same receipt/head evaluator.
function authorWorkPattern(work: string, row: AuthorWorkCandidate): string {
  return `{ GRAPH ${iri(GRAPHS.current)} { ${work} a rv:Post ; rv:head ?head . } }
    ${row.action === 'work.create' ? `UNION { GRAPH ${iri(GRAPHS.current)} {
      ${work} a schema:CreativeWork ; rv:head ?head ; rv:mainVersion ${iri(row.main_version)} . } }` : ''}
    ${unerased(work)}
    GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(row.graph_receipt)} ${row.action === 'work.create' ? `rv:work ${work} ; rv:mainVersion ${iri(row.main_version)} ;`
        : `(rv:post|rv:chapterWork) ${work} ;`}
        rv:admissionId ${lit(row.creation_admission)} ; rv:requestDigest ${lit(row.request_digest)} ;
        rv:admittedScope ${lit(row.scope_id)} ; rv:outcome rv:Succeeded .
    }`;
}

/** One candidate statement and one receipt/current-head proof for at most 65
 * requested Works. The response contains only distinct candidate keys, with a
 * fixed byte ceiling; unrelated author inventory is never enumerated. */
export async function authorWorkGenerations(client: PoolClient,
  graph: Pick<FusekiClient, 'query'> | undefined, principal: string, actor: string,
  works: readonly string[]): Promise<Map<string, string>> {
  const allowed = new Map<string, string>();
  if (!graph || !native.test(actor) || works.length > MAX_AUTHOR_WORKS
    || works.some(work => !native.test(work))) return allowed;
  const unique = [...new Set(works)].sort();
  if (!unique.length) return allowed;
  const candidates = await authorWorkCandidates(client, principal, actor, unique);
  if (!candidates.length) return allowed;
  const byWork = new Map(candidates.map(row => [row.resource, row]));
  if (candidates.length > unique.length || byWork.size !== candidates.length
    || candidates.some(row => !unique.includes(row.resource))) {
    throw new Error('author Work candidate batch is ambiguous');
  }
  const rows = (await graph.query(`PREFIX rv: <https://rezics.com/vocab/>
    PREFIX schema: <https://schema.org/> SELECT DISTINCT ?resource WHERE {
      ${candidates.map(row => `{ BIND(${iri(row.resource)} AS ?resource)
        FILTER EXISTS { ${authorWorkPattern('?resource', row)} } }`).join(' UNION ')}
    } LIMIT ${candidates.length + 1}`, AUTHOR_PROOF_BYTES)).results?.bindings ?? [];
  if (rows.length > candidates.length || rows.some(row => !byWork.has(row.resource?.value ?? ''))) {
    throw new Error('author Work proof batch is ambiguous');
  }
  for (const row of rows) {
    const work = row.resource!.value;
    allowed.set(work, byWork.get(work)!.generation);
  }
  return allowed;
}

/** The sealed Work or chapter creation receipt establishes provenance; the live
 * maintainer set and current controller establish authority. The
 * set lock orders this proof with transfers; a transfer back cannot revive a
 * saved generation. Referencing somebody else's Post in a composition never
 * confers editing rights over that Post.
 * Cost: six indexed singleton lookups and one 1 KiB ASK, independent of the
 * author's library size. No materialized per-resource permission grants. */
export async function authorWorkGeneration(client: PoolClient,
  graph: Pick<FusekiClient, 'query'> | undefined, principal: string, actor: string,
  work: string): Promise<string | null> {
  if (!graph || !native.test(work) || !native.test(actor)) return null;
  const row = (await authorWorkCandidates(client, principal, actor, work))[0];
  if (!row) return null;
  const allowed = await graph.query(`PREFIX rv: <https://rezics.com/vocab/>
    PREFIX schema: <https://schema.org/> ASK {
      ${authorWorkPattern(iri(work), row)}
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

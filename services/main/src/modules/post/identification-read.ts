import { Value } from 'typebox/value';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { readCurrentOccurrence, readExactDefinition } from '../relation/change.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadMissing, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import { readWorkHeader } from '../work/read-header.ts';
import { readPost } from './read.ts';
import { structureProfileFor } from '../structure/profiles.ts';
import { identificationEvidence, POST_IDENTIFICATION_COST } from './identification-schema.ts';
import { systemDisclosure } from '../target/disclosed-references.ts';

function evidenceOf(value: string | undefined) {
  if (!value) return null;
  const url = new URL(value);
  const post = /^\/v1\/posts\/([0-9a-f-]{36})\/identifications$/.exec(url.pathname)?.[1];
  const evidence = { kind: url.searchParams.get('kind'), ...(url.searchParams.has('sourceKind')
    ? { source: { kind: url.searchParams.get('sourceKind'), value: url.searchParams.get('source') } } : {}) };
  return url.origin === 'https://rezics.com' && post && Value.Check(identificationEvidence, evidence)
    ? { post: `https://rezics.com/id/${post}`, evidence, operation: url.searchParams.get('operation') } : null;
}

export async function readPostIdentification(session: WorkReadSession, id: string) {
  const relation = await readCurrentOccurrence(session.deps.environment, `https://rezics.com/id/${id}`);
  const evidence = evidenceOf(relation?.state.evidence);
  if (!relation || !evidence) throw new WorkReadMissing('Identification is unavailable');
  // System reader: only the definition's notation and role keys are used; no member list reaches the response.
  const definition = await readExactDefinition(session.deps.environment, relation.state.definition, systemDisclosure);
  if (definition?.notation !== 'composition-part') throw new WorkReadMissing('Identification is unavailable');
  const part = relation.state.participations.find(row => definition.roleKeys[row.role] === 'part')?.participant;
  if (part?.kind !== 'resource') throw new WorkReadMissing('Identification is unavailable');
  await readPost(session, evidence.post);
  const work = await readWorkHeader(session, part.ref);
  return { identification: `https://rezics.com/id/${id}`, post: evidence.post, work: work.id,
    title: work.title, relationRevision: relation.head, evidence: evidence.evidence, sourcePosition: session.position };
}

/** Indexed graph incidences, at most 100 candidates and 20 returned Works.
 * A visibility budget failure is unavailable, never a silently truncated list. */
export async function readPostIdentifications(session: WorkReadSession, post: string,
  operation?: string) {
  await readPost(session, post);
  const binding = ['post-identifications', post, session.options.actingSubject ?? null,
    session.options.language ?? null, operation ?? null];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const composition = structureProfileFor('book-composition');
  const rows = await session.query(`SELECT ?work ?main ?structure (MIN(STR(?placedOccurrence)) AS ?occurrence) WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(post)} a rv:Post . ?work a <${composition.ownerType}> ; rv:mainVersion ?main .
      ?structure a rv:Structure ; rv:structureOf ?main ; rv:structureProfile <${composition.graphProfile}> ; rv:selectedGeneration ?generation .
      ?generation rv:generationState rv:Active . ?placement a rv:OccurrencePlacement ; rv:generation ?generation ;
        rv:occurrence ?placedOccurrence ; rv:occurrenceRole rv:ChapterRole ; schema:item ${iri(post)} .
      FILTER NOT EXISTS { ?placement rv:removedBy ?removal }
      ?relation a rv:RelationOccurrence ; rv:occurrenceHead ?head .
      ?key a rv:DefinitionKey ; rv:keyDefinition ?definition ; skos:notation "composition-part" .
    }
    GRAPH ${iri(GRAPHS.revisions)} {
      ?head rv:lifecycle rv:Active ; rv:relationDefinition ?definitionRef ; rv:participation ?part, ?whole .
      ?definitionRef rv:component ?definition .
      ?part rv:role ?partRole ; rv:participant ?work . ?whole rv:role ?wholeRole ; rv:participant ?book .
    }
    FILTER(?partRole=IRI(CONCAT(STR(?definition),"/role/part")) && ?wholeRole=IRI(CONCAT(STR(?definition),"/role/whole")))
    FILTER(?work != ?book && STR(?work) > ${lit(cursor?.after ?? '')})
  } GROUP BY ?work ?main ?structure ORDER BY ?work LIMIT ${POST_IDENTIFICATION_COST.scan + 1}`,
  POST_IDENTIFICATION_COST.scan + 1);
  const items = [], limit = session.options.limit ?? POST_IDENTIFICATION_COST.page;
  let next: string | null = null;
  for (const row of rows.slice(0, POST_IDENTIFICATION_COST.scan)) {
    if (!row.work || !row.main || !row.structure || !row.occurrence) throw new WorkReadUnavailable('Identification graph is incomplete');
    if (operation) {
      const relations = await session.query(`SELECT ?relation WHERE { GRAPH ${iri(GRAPHS.revisions)} {
        ?participation rv:participant ${iri(row.work.value)} ; rv:occurrence ?relation .
      } GRAPH ${iri(GRAPHS.current)} { ?relation rv:occurrenceHead ?head } } LIMIT 101`, 101);
      let found = false;
      for (const candidate of relations) {
        const state = await readCurrentOccurrence(session.deps.environment, candidate.relation!.value);
        if (evidenceOf(state?.state.evidence)?.operation === operation) { found = true; break; }
      }
      if (!found) continue;
    }
    const summary = (await session.summaries([row.work.value]))[0];
    if (summary?.status !== 'available') continue;
    if (items.length === limit) { next = encodeReadCursor(binding, session.position, items.at(-1)!.work); break; }
    const header = await readWorkHeader(session, row.work.value);
    items.push({ work: row.work.value, mainVersion: row.main.value, structure: row.structure.value,
      occurrence: row.occurrence.value, title: header.title });
  }
  if (!next && rows.length > POST_IDENTIFICATION_COST.scan) throw new WorkReadUnavailable('Identification scan exceeds its budget');
  await readPost(session, post);
  // A page that stops at its limit continues; a scan that finishes inside the budget is the whole list.
  return { profile: 'post-identifications-v1' as const, post, ...pageResult(session, items, next),
    complete: next === null };
}

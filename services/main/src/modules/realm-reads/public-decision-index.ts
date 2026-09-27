import { readEpochOrder } from '../discovery/lineage.ts';
import { GRAPHS, RV, iri, lit } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, publicWork,
  WorkReadMissing, WorkReadUnavailable, type ReadRow, type WorkReadSession } from '../work/read-session.ts';
import { readRealmBasis } from './read-realm.ts';

function decisionRelation(realm: string) {
  return `{
      GRAPH ${iri(GRAPHS.revisions)} { ?id a rv:PublicationSelection, rv:RevisionAnchor ;
        rv:context ${iri(realm)} ; rv:work ?work ; rv:mainVersion ?main ;
        rv:contribution ?subject ; rv:publicationDecision ?decision ;
        rv:selectedDraft ?draft ; rv:dataEpoch ?revisionEpoch ; rv:sequence ?sequence .
        ?decision rv:disclosure rv:Public .
        FILTER NOT EXISTS { ?draft a rv:ErasedRevision } }
      ${publicWork('?work', '?main')}
      BIND("adoption" AS ?kind)
    } UNION {
      GRAPH ${iri(GRAPHS.current)} { ?application a rv:ClassificationApplication ;
        rv:classificationContext ?context ; rv:targetMainVersion ?main ; rv:sense ?subject .
        ?context a rv:ClassificationContext ; rv:realm ${iri(realm)} .
        ?main rv:work ?work . }
      GRAPH ${iri(GRAPHS.revisions)} { ?id a rv:ClassificationDecision, rv:RevisionAnchor ;
        rv:component ?application ; rv:outcome ?outcome ;
        rv:dataEpoch ?revisionEpoch ; rv:sequence ?sequence . }
      FILTER(?outcome IN (rv:Accepted, rv:Rejected))
      ${publicWork('?work', '?main')}
      BIND("classification" AS ?kind)
    } UNION {
      GRAPH ${iri(GRAPHS.current)} { ?slot a rv:ContextRule ; rv:realm ${iri(realm)} ;
        rv:context ?subject .
        ?subject a rv:SemanticContext ; rv:contextState rv:Active ; rv:disclosure rv:Public . }
      GRAPH ${iri(GRAPHS.revisions)} { ?id a rv:FiniteRuleRevision, rv:RevisionAnchor ;
        rv:component ?slot ; rv:realm ${iri(realm)} ;
        rv:dataEpoch ?revisionEpoch ; rv:sequence ?sequence . }
      BIND("semantic-rule-change" AS ?kind)
    }`;
}

function decisionItem(row: ReadRow) {
  const kind = row.kind!.value;
  if (!['adoption', 'classification', 'semantic-rule-change'].includes(kind)
    || kind === 'classification' && ![`${RV}Accepted`, `${RV}Rejected`].includes(row.outcome?.value ?? '')
    || kind !== 'semantic-rule-change' && (!row.work || !row.subject)) {
    throw new WorkReadUnavailable('Public decision index has invalid fields');
  }
  return { id: row.id!.value, kind, dataEpoch: row.revisionEpoch!.value,
    sequence: row.sequence!.value, work: row.work?.value ?? null, subject: row.subject?.value ?? null,
    outcome: row.outcome?.value === `${RV}Accepted` ? 'accepted' as const
      : row.outcome?.value === `${RV}Rejected` ? 'rejected' as const : null };
}

/** Public graph revision index: no receipts, private actors or Access roster rows enter this relation.
 * One keyset page is chosen across all event families before any response mapping.
 * One lineage read, one relation query, two basis probes and two position fences
 * bound graph round trips. Jena can scan/sort D eligible revisions (O(D log D));
 * a materialized seek index needs its own writer/retention owner before large-scale use. */
export async function readRealmDecisions(session: WorkReadSession, realm: string) {
  await readRealmBasis(session, realm);
  const limit = session.options.limit ?? 20;
  const binding = ['realm-decisions-v1', realm];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const order = cursor?.order.split(':');
  if (order && (order.length !== 2 || !order.every(value => /^\d+$/.test(value)))) {
    throw new WorkReadUnavailable('Decision cursor ordering is unavailable');
  }
  const epochs = await readEpochOrder(session);
  const rows = await session.query(`SELECT DISTINCT ?id ?kind ?work ?subject ?outcome
    ?revisionEpoch ?sequence ?epochOrder WHERE {
    ${epochs}
    ${decisionRelation(realm)}
    ${cursor && order ? `FILTER(?epochOrder > ${order[0]} || (?epochOrder = ${order[0]}
      && (?sequence < ${order[1]} || (?sequence = ${order[1]} && STR(?id) > ${lit(cursor.after)}))))` : ''}
  } ORDER BY ?epochOrder DESC(?sequence) STR(?id) LIMIT ${limit + 1}`, limit + 1);
  if (rows.some(row => !row.id || !row.kind || !row.revisionEpoch || !row.sequence
    || !row.epochOrder || !/^\d+$/.test(row.sequence.value))
    || new Set(rows.map(row => row.id!.value)).size !== rows.length) {
    throw new WorkReadUnavailable('Public decision index is incomplete');
  }
  const page = rows.slice(0, limit);
  const items = page.map(decisionItem);
  await readRealmBasis(session, realm);
  const last = page.at(-1);
  return { profile: 'realm-decisions-v1' as const,
    ...pageResult(session, items, rows.length > limit && last
      ? encodeReadCursor(binding, session.position, last.id!.value,
        `${last.epochOrder!.value}:${last.sequence!.value}`) : null) };
}

/** Exact public Decision, using the same disclosure relation as the paged log. */
export async function readRealmDecision(session: WorkReadSession, realm: string, decision: string) {
  await readRealmBasis(session, realm);
  const rows = await session.query(`SELECT DISTINCT ?id ?kind ?work ?subject ?outcome
    ?revisionEpoch ?sequence WHERE {
    ${decisionRelation(realm)}
    FILTER(?id = ${iri(decision)})
  } LIMIT 2`, 2);
  if (!rows.length) throw new WorkReadMissing('Decision is unavailable');
  if (rows.length !== 1 || !rows[0]?.id || !rows[0].kind || !rows[0].revisionEpoch
    || !/^\d+$/.test(rows[0].sequence?.value ?? '')) {
    throw new WorkReadUnavailable('Public Decision is ambiguous');
  }
  await readRealmBasis(session, realm);
  return { profile: 'realm-decision-v1' as const, ...decisionItem(rows[0]),
    sourcePosition: session.position };
}

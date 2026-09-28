import { t } from 'elysia';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { readId, readUuid, pageFields } from '../work/read-contract.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, type WorkReadSession } from '../work/read-session.ts';
import { unerased } from '../work/public-patterns.ts';

export const realmPublicationPage = t.Object({ items: t.Array(t.Object({ work: readId,
  resource: readId, selection: readId, kind: t.Union([t.Literal('work'), t.Literal('content-publication')]),
  variant: t.String(), publicationDecision: t.String(), contentRevision: readUuid,
}), { maxItems: 20 }), ...pageFields });

/** A following selection joins the current Structure generation at read time:
 * no corpus-sized fan-out on publish. Fixed Content selections require their
 * exact publication still to be public. Private, superseded, removed and erased
 * chapters never become visible through the parent adoption. Cost: one bounded
 * 21-row relation plus normal Realm/position fences, O(P) output; conservative
 * discovery/sort O(N log N) in the adopted Work's current placements. */
export async function readRealmPublications(session: WorkReadSession, realm: string, work: string) {
  await session.realm(realm);
  const limit = session.options.limit ?? 20;
  const binding = ['realm-submitted-publications-v1', realm, work];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const rows = await session.query(`SELECT DISTINCT ?resource ?variant ?publication ?revision ?selection ?kind WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ?slot a rv:RealmResourceSlot ; rv:realm ${iri(realm)} ; rv:work ${iri(work)} ;
        rv:mainVersion ?main ; rv:selectionHead ?selection ; rv:submissionKind ?kind . }
    GRAPH ${iri(GRAPHS.revisions)} { ?selection a rv:RealmSubmissionSelection ; rv:component ?slot . }
    { GRAPH ${iri(GRAPHS.revisions)} { ?selection rv:selectionMode rv:Following }
      { BIND(${iri(work)} AS ?resource) }
      UNION { GRAPH ${iri(GRAPHS.current)} {
        ?structure a rv:Structure ; rv:structureOf ?main ; rv:selectedGeneration ?generation .
        ?placement a rv:OccurrencePlacement ; rv:generation ?generation ; rv:occurrenceRole rv:ChapterRole ;
          schema:item ?resource .
        FILTER NOT EXISTS { ?placement rv:removedBy ?removal }
      } }
    } UNION { BIND(${iri(work)} AS ?resource)
      GRAPH ${iri(GRAPHS.revisions)} { ?selection rv:selectionMode rv:Fixed ; rv:variant ?variant ;
        rv:publicationDecision ?publication ; rv:contentRevision ?revision } }
    GRAPH ${iri(GRAPHS.current)} {
      ?variant a rv:ContentVariant ; rv:resource ?resource ; rv:contentPublicationHead ?publication ;
        rv:publicSearchEligibilityHead ?eligibility . }
    GRAPH ${iri(GRAPHS.revisions)} {
      ?publication a rv:ContentPublicationDecision ; rv:resource ?resource ; rv:contentRevision ?revision .
      ?eligibility a rv:ContentSearchEligibilityDecision ; rv:publicationDecision ?publication ; rv:disclosure rv:Public .
      FILTER NOT EXISTS { ?revision a rv:ErasedRevision }
    }
    ${unerased(iri(work))} ${unerased('?resource')}
    ${cursor ? `FILTER(STR(?variant) > ${lit(cursor.after)} || (STR(?variant) = ${lit(cursor.after)}
      && STR(?selection) > ${lit(cursor.order)}))` : ''}
  } ORDER BY STR(?variant) STR(?selection) LIMIT ${limit + 1}`, limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  await session.realm(realm);
  return pageResult(session, page.map(row => ({ work, resource: row.resource!.value,
    selection: row.selection!.value, kind: row.kind!.value as 'work' | 'content-publication',
    variant: row.variant!.value, publicationDecision: row.publication!.value,
    contentRevision: row.revision!.value.slice('urn:rezics:content:revision:'.length) })), rows.length > limit && last
    ? encodeReadCursor(binding, session.position, last.variant!.value, last.selection!.value) : null);
}

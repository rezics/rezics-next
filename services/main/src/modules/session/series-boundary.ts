import { GRAPHS, iri } from '../work/activate.ts';
import type { WorkReadSession } from '../work/read-session.ts';
import type { SessionState } from './contract.ts';

/** Occurrence order is comparable only inside one exact Structure revision.
 * At most 4096 pins and four ancestor joins, one graph batch. A changed text or
 * composition needs reviewed correspondence, never numeric order inference. */
export async function furthestSeriesOccurrence(session: WorkReadSession, work: string, language: string,
  attempts: SessionState[]) {
  const pins = new Map(attempts.filter(attempt => attempt.state === 'finished').flatMap(attempt => attempt.selections
    .filter(selection => selection.target.base === 'occurrence' && selection.target.work === work
      && (selection.language === null || selection.language.toLowerCase() === language.toLowerCase()))
    .map(selection => [`${selection.target.resource}|${selection.target.revision}`, selection.target] as const)));
  if (!pins.size) return { occurrence: null, unresolved: false };
  const rows = await session.query(`SELECT ?resource ?revision ?structure ?segmentKey ?orderKey
    ?groupSegment1 ?groupOrder1 ?groupSegment2 ?groupOrder2 ?groupSegment3 ?groupOrder3 WHERE {
    VALUES (?resource ?revision) { ${[...pins.values()].map(target => `(${iri(target.resource)} ${iri(target.revision)})`).join(' ')} }
    GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:StructureRevision ; rv:component ?structure ; rv:generation ?generation }
    GRAPH ${iri(GRAPHS.current)} {
      ?placement a rv:OccurrencePlacement ; rv:generation ?generation ; rv:occurrence ?resource ;
        rv:orderSegment ?segment ; rv:orderKey ?orderKey .
      FILTER NOT EXISTS { ?placement rv:removedBy ?removed }
      ?segment rv:parent ?parent ; rv:segmentKey ?segmentKey .
      OPTIONAL { ?group1 a rv:OccurrencePlacement ; rv:generation ?generation ; rv:occurrence ?parent ;
        rv:orderSegment ?gs1 ; rv:orderKey ?groupOrder1 . ?gs1 rv:segmentKey ?groupSegment1 ; rv:parent ?parent2 .
        OPTIONAL { ?group2 a rv:OccurrencePlacement ; rv:generation ?generation ; rv:occurrence ?parent2 ;
          rv:orderSegment ?gs2 ; rv:orderKey ?groupOrder2 . ?gs2 rv:segmentKey ?groupSegment2 ; rv:parent ?parent3 .
          OPTIONAL { ?group3 a rv:OccurrencePlacement ; rv:generation ?generation ; rv:occurrence ?parent3 ;
            rv:orderSegment ?gs3 ; rv:orderKey ?groupOrder3 . ?gs3 rv:segmentKey ?groupSegment3 . }
        }
      }
    }
  } LIMIT ${pins.size + 1}`, pins.size);
  if (rows.length !== pins.size || new Set(rows.map(row => `${row.structure?.value}|${row.revision?.value}`)).size !== 1) {
    return { occurrence: null, unresolved: true };
  }
  const key = (row: typeof rows[number]) => [row.groupSegment3?.value, row.groupOrder3?.value,
    row.groupSegment2?.value, row.groupOrder2?.value, row.groupSegment1?.value, row.groupOrder1?.value,
    row.segmentKey?.value, row.orderKey?.value].filter(value => value !== undefined).join('\u0001');
  const furthest = rows.reduce((a, b) => key(a) > key(b) ? a : b);
  return { occurrence: { resource: furthest.resource!.value, revision: furthest.revision!.value }, unresolved: false };
}

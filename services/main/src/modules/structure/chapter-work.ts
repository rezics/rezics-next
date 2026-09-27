import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';

/** A new chapter has an immutable parent; older chapters use their one active
 * Book placement. One bounded graph query resolves a reader batch of ≤24. */
export async function canonicalChapterWorks(session: WorkReadSession, works: readonly string[]) {
  if (!works.length) return new Map<string, string>();
  if (works.length > 24) throw new WorkReadUnavailable('Chapter lookup exceeds batch budget');
  const rows = await session.query(`SELECT DISTINCT ?child ?parent WHERE {
    VALUES ?child { ${works.map(iri).join(' ')} }
    { GRAPH ${iri(GRAPHS.current)} { ?child schema:isPartOf ?parent . } }
    UNION
    { GRAPH ${iri(GRAPHS.current)} {
        ?structure a rv:Structure ; rv:structureProfile rv:BookComposition ;
          rv:structureOf ?main ; rv:selectedGeneration ?generation .
        ?main rv:work ?parent .
        ?placement a rv:OccurrencePlacement ; rv:generation ?generation ;
          rv:occurrenceRole rv:ChapterRole ; schema:item ?child .
        FILTER NOT EXISTS { ?placement rv:removedBy ?removal }
        FILTER NOT EXISTS { ?child schema:isPartOf ?directParent }
      } }
    FILTER(?child != ?parent)
  } LIMIT 49`, 48);
  const parents = new Map<string, string>();
  for (const row of rows) {
    if (!row.child || !row.parent || !works.includes(row.child.value)
      || parents.has(row.child.value) && parents.get(row.child.value) !== row.parent.value) {
      throw new WorkReadUnavailable('Chapter parent is ambiguous');
    }
    parents.set(row.child.value, row.parent.value);
  }
  return parents;
}

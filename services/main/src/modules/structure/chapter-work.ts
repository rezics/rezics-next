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

/**
 * Where a chapter Work is read: its Book and its one active chapter occurrence in the Book's current Main
 * Version composition (null when it has none, or several). A chapter made as a part of its Book keeps that
 * Book; an older chapter is the chapter of the one Book that places it. Null for any other Work, including
 * one several Books place. One bounded graph query.
 */
export async function chapterPlace(session: WorkReadSession, work: string) {
  return chapterPlaceFromRows(await session.query(chapterPlaceQuery(work), 8));
}

/** Also embedded in the Work basis read so the header needs no extra round trip. */
export function chapterPlaceQuery(work: string): string {
  return `SELECT DISTINCT ?book ?occurrence ?declared WHERE {
    { GRAPH ${iri(GRAPHS.current)} { ${iri(work)} schema:isPartOf ?book . } BIND(true AS ?declared) }
    UNION
    { GRAPH ${iri(GRAPHS.current)} {
        ?structure a rv:Structure ; rv:structureProfile rv:BookComposition ;
          rv:structureOf ?main ; rv:selectedGeneration ?generation .
        ?main rv:work ?book . ?book rv:mainVersion ?main .
        ?placement a rv:OccurrencePlacement ; rv:generation ?generation ;
          rv:occurrenceRole rv:ChapterRole ; schema:item ${iri(work)} ; rv:occurrence ?occurrence .
        FILTER NOT EXISTS { ?placement rv:removedBy ?removal }
      } }
    FILTER(?book != ${iri(work)})
  } LIMIT 8`;
}

export function chapterPlaceFromRows(rows: Awaited<ReturnType<WorkReadSession['query']>>) {
  const declared = rows.find(row => row.declared)?.book?.value;
  const books = new Set(rows.flatMap(row => row.book ? [row.book.value] : []));
  const book = declared ?? (books.size === 1 ? [...books][0]! : null);
  if (!book) return null;
  const places = rows.filter(row => row.book?.value === book && row.occurrence);
  return { work: book, occurrence: places.length === 1 ? places[0]!.occurrence!.value : null };
}

import { postBookPlacement } from '../post/patterns.ts';
import { iri } from '../work/activate.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';

/** A compatibility lookup for callers holding a Post IRI. Independent Works
 * placed in a Book remain Works. Multiple Books never silently select a parent. */
export async function postBooks(session: WorkReadSession, resources: readonly string[]) {
  if (!resources.length) return new Map<string, string>();
  if (resources.length > 24) throw new WorkReadUnavailable('Post lookup exceeds batch budget');
  const rows = await session.query(
    `SELECT DISTINCT ?child ?parent WHERE {
    VALUES ?child { ${resources.map(iri).join(' ')} }
    ${postBookPlacement('?child', '?parent', '?parentMain')}
  } LIMIT 49`,
    48,
  );
  const parents = new Map<string, string>();
  for (const row of rows) {
    if (
      !row.child ||
      !row.parent ||
      !resources.includes(row.child.value) ||
      (parents.has(row.child.value) && parents.get(row.child.value) !== row.parent.value)
    ) {
      throw new WorkReadUnavailable('Post is placed in multiple Books; select an occurrence');
    }
    parents.set(row.child.value, row.parent.value);
  }
  return parents;
}

/** Legacy Work links redirect only a Post with one unambiguous active Book use. */
export async function postBookPlace(session: WorkReadSession, resource: string) {
  return postBookPlaceFromRows(await session.query(postBookPlaceQuery(resource), 8));
}

export function postBookPlaceQuery(resource: string): string {
  return `SELECT DISTINCT ?book ?occurrence WHERE {
    ${postBookPlacement(iri(resource), '?book', '?postMain', '?occurrence')}
  } LIMIT 8`;
}

export function postBookPlaceFromRows(rows: Awaited<ReturnType<WorkReadSession['query']>>) {
  const books = new Set(rows.flatMap((row) => (row.book ? [row.book.value] : [])));
  if (books.size !== 1) return null;
  const book = [...books][0]!;
  const places = rows.filter((row) => row.book?.value === book && row.occurrence);
  return { work: book, occurrence: places.length === 1 ? places[0]!.occurrence!.value : null };
}

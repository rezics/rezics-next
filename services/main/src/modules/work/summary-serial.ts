import { GRAPHS, iri } from './activate.ts';
import { readMetadataHeader, selectedMetadata } from './metadata-read.ts';
import { WorkReadUnavailable, type WorkReadSession } from './read-session.ts';

/** Metadata is editor-owned. Chapter and word totals need a publication projection;
 * unknown is represented as null rather than inferred from private or stale bytes. */
export async function readSerialSummaries(session: WorkReadSession, works: readonly string[]) {
  const result = new Map<string, { tagline: ReturnType<typeof selectedMetadata>['tagline'];
    completionStatus: 'ongoing' | 'completed' | 'hiatus' | null;
    chapterCount: null; wordCount: null; lastUpdatedAt: null }>();
  if (!works.length) return result;
  if (works.length > 20 || new Set(works).size !== works.length) {
    throw new WorkReadUnavailable('Serial summary batch is out of bounds');
  }
  const rows = await session.query(`SELECT ?work ?head WHERE {
    VALUES ?work { ${works.map(iri).join(' ')} }
    OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?work rv:descriptiveMetadataHead ?head } }
  } LIMIT ${works.length + 1}`, works.length + 1);
  if (rows.length !== works.length || new Set(rows.map(row => row.work?.value)).size !== works.length
    || rows.some(row => !row.work || !works.includes(row.work.value))) {
    throw new WorkReadUnavailable('Serial summary heads are ambiguous');
  }
  for (const row of rows) {
    const header = await readMetadataHeader(session, row.work!.value, row.head?.value ?? null);
    const selected = selectedMetadata(header, session.options.language);
    result.set(row.work!.value, { tagline: selected.tagline,
      completionStatus: header.completionStatus, chapterCount: null,
      wordCount: null, lastUpdatedAt: null });
  }
  return result;
}

import { GRAPHS, iri } from './activate.ts';
import type { SerialStatus } from './metadata-schema.ts';
import { readMetadataHeader, selectedMetadata } from './metadata-read.ts';
import { WorkReadUnavailable, readDependencyToken, type ReadRow, type WorkReadSession } from './read-session.ts';
import { SearchSnapshotMoved } from './search-readiness.ts';
import { optionalPreview } from '../query/optional-preview.ts';
import { readFactObligations } from '../rights/read-imported.ts';
import type { WikiDisplayObligations } from '../rights/store.ts';

export const EMPTY_SERIAL_SUMMARY = { tagline: null, completionStatus: null,
  chapterCount: null, wordCount: null, lastUpdatedAt: null } as const;

/** Every consumer closes the selected statistics owner's materialization and
 * live child/body disclosure, including absent and optional preview results. */
export async function readSerialStatistics(session: WorkReadSession, works: readonly string[], preview = false) {
  if (!session.deps.serialStats) return undefined;
  const read = () => session.deps.serialStats?.batch(works, session.position.sequence);
  const current = async () => preview ? await optionalPreview(session, async () => read()) : await read();
  const stats = await current();
  const selected = (values: typeof stats) => values == null ? null : works.map(work => [work, values.get(work) ?? null]);
  session.observeDependency(`serial-statistics:${JSON.stringify(works)}`, selected(stats), async () => selected(await current()));
  return stats;
}

/** Metadata is editor-owned; numeric facts are from the durable relay projection.
 * A caller supplying heads owns their closing dependency (for example, the
 * Realm's selected page includes its exact metadata heads). */
export async function readSerialSummaries(session: WorkReadSession, works: readonly string[], preview = false,
  selectedHeads?: readonly ReadRow[]) {
  const result = new Map<string, { tagline: ReturnType<typeof selectedMetadata>['tagline'];
    factObligations?: WikiDisplayObligations;
    completionStatus: SerialStatus | null;
    chapterCount: number | null; wordCount: number | null; lastUpdatedAt: string | null;
    unavailablePreviews?: ['serial'] }>();
  if (!works.length) return result;
  if (works.length > 20 || new Set(works).size !== works.length) {
    throw new WorkReadUnavailable('Serial summary batch is out of bounds');
  }
  const rows = selectedHeads ?? await session.query(`SELECT ?work ?head WHERE {
    VALUES ?work { ${works.map(iri).join(' ')} }
    OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?work rv:descriptiveMetadataHead ?head } }
  } LIMIT ${works.length + 1}`, works.length + 1);
  if (rows.length !== works.length || new Set(rows.map(row => row.work?.value)).size !== works.length
    || rows.some(row => !row.work || !works.includes(row.work.value))) {
    throw new WorkReadUnavailable('Serial summary heads are ambiguous');
  }
  const stats = await readSerialStatistics(session, works, preview);
  const factObligations = preview ? null : await readFactObligations(session, works);
  for (const row of rows) {
    const header = preview
      ? await optionalPreview(session, () => readMetadataHeader(session, row.work!.value, row.head?.value ?? null))
      : await readMetadataHeader(session, row.work!.value, row.head?.value ?? null);
    if (!header) continue;
    const selected = selectedMetadata(header, session.options.language);
    result.set(row.work!.value, { tagline: selected.tagline,
      ...(factObligations ? { factObligations: factObligations.get(row.work!.value) } : {}),
      ...(preview && stats !== undefined && !stats?.has(row.work!.value) ? { unavailablePreviews: ['serial'] } : {}),
      completionStatus: header.completionStatus,
      chapterCount: stats?.get(row.work!.value)?.chapterCount ?? null,
      wordCount: stats?.get(row.work!.value)?.wordCount ?? null,
      lastUpdatedAt: stats?.get(row.work!.value)?.lastUpdatedAt ?? null });
  }
  return result;
}

/** Public search has a larger, fixed 512-Work relation than card reads. */
export async function enrichSerialSearch<T>(relation: T,
  stats: WorkReadSession['deps']['serialStats']): Promise<T> {
  if (!relation || typeof relation !== 'object') return relation;
  const value = relation as Record<string, unknown>;
  if (value.resultGrain !== 'mainVersion' || !Array.isArray(value.results)
    || !value.sourcePosition || typeof value.sourcePosition !== 'object') return relation;
  const matches = value.results as Array<{ work: string } & Record<string, unknown>>;
  if (matches.length > 512 || matches.some(match => typeof match.work !== 'string')) {
    throw new WorkReadUnavailable('Search serial relation exceeds its bound');
  }
  const ids = [...new Set(matches.map(match => match.work))];
  const graphSequence = (value.sourcePosition as { sequence?: unknown }).sequence;
  const projected = stats && typeof graphSequence === 'string'
    ? await stats.batch(ids, graphSequence) : null;
  if (stats && projected && typeof graphSequence === 'string') {
    const current = await stats.batch(ids, graphSequence);
    const selected = (values: typeof projected) => ids.map(work => [work, values.get(work) ?? null]);
    if (readDependencyToken(selected(projected)) !== readDependencyToken(selected(current))) {
      throw new SearchSnapshotMoved('Selected serial search statistics changed during hydration');
    }
  }
  return { ...value, results: matches.map(match => ({ ...match,
    chapterCount: projected?.get(match.work)?.chapterCount ?? null,
    wordCount: projected?.get(match.work)?.wordCount ?? null,
    lastUpdatedAt: projected?.get(match.work)?.lastUpdatedAt ?? null })) } as T;
}

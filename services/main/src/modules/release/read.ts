import { GRAPHS, iri, lit } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadMissing, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import { fenceWorkBasis, readWorkBasis } from '../work/read-header.ts';
import { recordedLanguageTag, InvalidContentLanguages } from './languages.ts';
import { parseStoredRelease, RELEASE_COST, RELEASE_PROFILE, ReleaseUnavailable, type ReleaseRecord } from './schema.ts';

export interface SnapshotView {
  id: string; fetchedAt: string; byteDigest: string; byteLength: number;
  coverage: { scope: string; complete: boolean }; acquisition: 'fixture' | 'fetch';
}
export interface ReleaseView {
  id: string; revision: string; kind: ReleaseRecord['kind']; status: ReleaseRecord['status'];
  contentLanguages: string[]; isTranslation: boolean; originalLanguages: string[];
  titleLanguage: string | null; tracklistLanguage: string | null;
  title: ReleaseRecord['title']; publisher: string | null; publicationYear: number | null;
  originalUrl: string | null; fixedRelease: string | null;
  coverage: ReleaseRecord['coverage']; snapshots: SnapshotView[];
}

function viewOf(record: ReleaseRecord, revision: string, snapshots: SnapshotView[]): ReleaseView {
  return { id: record.id, revision, kind: record.kind, status: record.status,
    contentLanguages: record.contentLanguages, isTranslation: record.isTranslation,
    originalLanguages: record.originalLanguages, titleLanguage: record.titleLanguage,
    tracklistLanguage: record.tracklistLanguage, title: record.title, publisher: record.publisher,
    publicationYear: record.publicationYear, originalUrl: record.originalUrl, fixedRelease: record.fixedRelease,
    coverage: record.coverage, snapshots };
}

function parseRecord(raw: string, work: string, release: string): ReleaseRecord {
  try {
    const record = parseStoredRelease(raw, work);
    if (record.id !== release) throw new WorkReadUnavailable('Release projection differs');
    return record;
  } catch (error) {
    if (error instanceof ReleaseUnavailable || error instanceof WorkReadUnavailable) {
      throw new WorkReadUnavailable('Release state is invalid');
    }
    throw error;
  }
}

/** Candidates, then one hydration of the page, then one snapshot batch.
 * Native Jena may scan R release identities, conservatively O(R log R), then O(S) bounded snapshots. */
export async function readWorkReleases(session: WorkReadSession, work: string, contentLanguage?: string) {
  const basis = await readWorkBasis(session, work);
  const limit = session.options.limit ?? RELEASE_COST.page;
  let listed: string | null = null;
  if (contentLanguage) {
    try { listed = recordedLanguageTag(contentLanguage); }
    catch (error) {
      if (error instanceof InvalidContentLanguages) throw new WorkReadUnavailable('Language filter is invalid');
      throw error;
    }
  }
  const binding = ['releases', work, listed];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const rows = await session.query(`SELECT ?release ?revision WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?release a rv:Release ; rv:work ${iri(work)} ; rv:releaseHead ?revision .
      ${listed ? `?release rv:contentLanguages ?langs .
        FILTER(CONTAINS(CONCAT(" ", STR(?langs), " "), ${lit(` ${listed} `)}))` : ''}
    } ${cursor ? `FILTER(STR(?release) > ${lit(cursor.after)})` : ''}
  } ORDER BY STR(?release) LIMIT ${limit + 1}`, limit + 1);
  if (rows.some(row => !row.release || !row.revision) || new Set(rows.map(row => row.release!.value)).size !== rows.length) {
    throw new WorkReadUnavailable('Release identities are ambiguous');
  }
  const page = rows.slice(0, limit);
  const hydrated = page.length ? await session.query(`SELECT ?release ?revision ?state WHERE {
    VALUES (?release ?revision) { ${page.map(row => `(${iri(row.release!.value)} ${iri(row.revision!.value)})`).join(' ')} }
    GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ReleaseRevision ; rv:component ?release ;
      rv:modelRevision ${iri(RELEASE_PROFILE)} ; rv:releaseState ?state }
  } LIMIT ${limit + 1}`, limit + 1) : [];
  if (hydrated.length !== page.length) throw new WorkReadUnavailable('Release revisions are incomplete');
  const byRelease = new Map(hydrated.map(row => [row.release?.value, row]));
  const records = page.map(row => {
    const hit = byRelease.get(row.release!.value);
    if (!hit?.state || hit.revision?.value !== row.revision!.value) throw new WorkReadUnavailable('Release payload is missing');
    return parseRecord(hit.state.value, work, row.release!.value);
  });
  const web = records.filter(record => record.kind === 'web').map(record => iri(record.id));
  const snapshotRows = web.length ? await session.query(`SELECT ?publication ?snapshot ?fetched ?digest ?bytes ?scope ?complete ?acquisition WHERE {
    VALUES ?publication { ${web.join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?snapshot a rv:WebSnapshot ; rv:publication ?publication ; rv:work ${iri(work)} ;
      rv:fetchedAt ?fetched ; rv:byteDigest ?digest ; rv:byteLength ?bytes ; rv:coverageScope ?scope ;
      rv:coverageComplete ?complete ; rv:acquisition ?acquisition }
  } ORDER BY ?fetched LIMIT ${RELEASE_COST.snapshots * web.length + 1}`, RELEASE_COST.snapshots * web.length + 1) : [];
  const snapshots = new Map<string, SnapshotView[]>();
  for (const row of snapshotRows) {
    const publication = row.publication?.value;
    if (!publication || !row.snapshot || !row.fetched || !row.digest || !row.bytes || !row.scope || !row.complete
      || (row.acquisition?.value !== 'fixture' && row.acquisition?.value !== 'fetch')) {
      throw new WorkReadUnavailable('Snapshot projection differs');
    }
    const list = snapshots.get(publication) ?? [];
    if (list.length < RELEASE_COST.snapshots) list.push({ id: row.snapshot.value, fetchedAt: row.fetched.value,
      byteDigest: row.digest.value, byteLength: Number(row.bytes.value),
      coverage: { scope: row.scope.value, complete: row.complete.value === 'true' },
      acquisition: row.acquisition.value });
    snapshots.set(publication, list);
  }
  await fenceWorkBasis(session, basis);
  return pageResult(session, records.map(record => viewOf(record, byRelease.get(record.id)!.revision!.value,
    snapshots.get(record.id) ?? [])), rows.length > limit
    ? encodeReadCursor(binding, session.position, page.at(-1)!.release!.value) : null);
}

export async function readWorkRelease(session: WorkReadSession, work: string, release: string) {
  const basis = await readWorkBasis(session, work);
  const rows = await session.query(`SELECT ?revision ?state WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(release)} a rv:Release ; rv:work ${iri(work)} ; rv:releaseHead ?revision }
    GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ReleaseRevision ; rv:component ${iri(release)} ;
      rv:modelRevision ${iri(RELEASE_PROFILE)} ; rv:releaseState ?state }
  } LIMIT 2`, 2);
  if (!rows.length) throw new WorkReadMissing('Release is unavailable');
  if (rows.length !== 1 || !rows[0]?.revision || !rows[0].state) throw new WorkReadUnavailable('Release revision is incomplete');
  const record = parseRecord(rows[0].state.value, work, release);
  const snapshotRows = record.kind === 'web' ? await session.query(
    `SELECT ?snapshot ?fetched ?digest ?bytes ?scope ?complete ?acquisition WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?snapshot a rv:WebSnapshot ; rv:publication ${iri(release)} ; rv:work ${iri(work)} ;
        rv:fetchedAt ?fetched ; rv:byteDigest ?digest ; rv:byteLength ?bytes ; rv:coverageScope ?scope ;
        rv:coverageComplete ?complete ; rv:acquisition ?acquisition }
    } ORDER BY ?fetched LIMIT ${RELEASE_COST.snapshots + 1}`, RELEASE_COST.snapshots + 1) : [];
  const snapshots: SnapshotView[] = [];
  for (const row of snapshotRows) {
    if (!row.snapshot || !row.fetched || !row.digest || !row.bytes || !row.scope || !row.complete
      || (row.acquisition?.value !== 'fixture' && row.acquisition?.value !== 'fetch')) {
      throw new WorkReadUnavailable('Snapshot projection differs');
    }
    if (snapshots.length < RELEASE_COST.snapshots) snapshots.push({ id: row.snapshot.value, fetchedAt: row.fetched.value,
      byteDigest: row.digest.value, byteLength: Number(row.bytes.value),
      coverage: { scope: row.scope.value, complete: row.complete.value === 'true' },
      acquisition: row.acquisition.value });
  }
  await fenceWorkBasis(session, basis);
  return { ...viewOf(record, rows[0].revision.value, snapshots), sourcePosition: session.position };
}

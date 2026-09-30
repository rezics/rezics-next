import { Value } from 'typebox/value';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadMissing, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import { fenceWorkBasis, readWorkBasis } from '../work/read-header.ts';
import { recordedLanguageTag, InvalidContentLanguages } from './languages.ts';
import { parseStoredRelease, RELEASE_COST, RELEASE_PROFILE, RELEASE_V2_PROFILE, RELEASE_V2_COST, isbnOk, releaseIdentifier, identifierLiteral, InvalidRelease, ReleaseUnavailable, type AnyReleaseRecord } from './schema.ts';

export interface SnapshotView {
  id: string; fetchedAt: string; byteDigest: string; byteLength: number;
  coverage: { scope: string; complete: boolean }; acquisition: 'fixture' | 'fetch';
}
export interface ReleaseView {
  profile: 'release-v2'; id: string; revision: string; kind: AnyReleaseRecord['kind']; status: AnyReleaseRecord['status'];
  contentLanguages: string[]; isTranslation: boolean; originalLanguages: string[];
  titleLanguage: string | null; tracklistLanguage: string | null;
  title: AnyReleaseRecord['title']; publisher: string | null; publicationYear: number | null;
  editionStatement: string | null; isbn13: string | null;
  originalUrl: string | null; fixedRelease: string | null;
  identifiers: { provider: string; value: string }[]; platform: string | null; territory: string | null;
  coverage: { realization: string | null; revision: string | null; work: string; mainVersion: string;
    completeness: 'complete' | 'partial' | 'trial' | 'unknown'; portion?: string;
    language: string | null }[];
  legacyCoverage: { scope: string; complete: boolean } | null; snapshots: SnapshotView[];
}

function viewOf(record: AnyReleaseRecord, revision: string, snapshots: SnapshotView[], main: Map<string, string>): ReleaseView {
  const coverage = record.profile === 'release-v2' ? record.coverage.map(entry => {
    const covered = record.resolvedCoverage.find(row => row.realization === entry.realization)!;
    return { ...entry, work: covered.work, mainVersion: main.get(covered.work)!, language: covered.language };
  }) : [{ realization: null, revision: null, work: record.work, mainVersion: main.get(record.work)!,
    completeness: 'unknown' as const, language: null }];
  return { profile: 'release-v2', id: record.id, revision, kind: record.kind, status: record.status,
    contentLanguages: record.contentLanguages, isTranslation: record.isTranslation,
    originalLanguages: record.originalLanguages, titleLanguage: record.titleLanguage,
    tracklistLanguage: record.tracklistLanguage, title: record.title, publisher: record.publisher,
    editionStatement: record.editionStatement, isbn13: record.isbn13, publicationYear: record.publicationYear,
    originalUrl: record.originalUrl, fixedRelease: record.fixedRelease,
    coverage, legacyCoverage: record.profile === 'release-v1' ? record.coverage : null,
    identifiers: record.profile === 'release-v2' ? record.identifiers : [],
    platform: record.profile === 'release-v2' ? record.platform : null,
    territory: record.profile === 'release-v2' ? record.territory : null, snapshots };
}

function coveredWorks(record: AnyReleaseRecord): string[] {
  return record.profile === 'release-v2' ? [...new Set(record.resolvedCoverage.map(entry => entry.work))] : [record.work];
}

/** At most 20 x 64 coverage entries, batched in the summary owner's groups of 64.
 * Disclosure fences cover every Work of an omnibus, including on identifier reads. */
async function completeViews(session: WorkReadSession,
  entries: { record: AnyReleaseRecord; revision: string; snapshots: SnapshotView[] }[]): Promise<ReleaseView[]> {
  const works = [...new Set(entries.flatMap(entry => coveredWorks(entry.record)))];
  const readable = new Set<string>();
  for (let offset = 0; offset < works.length; offset += 64) {
    for (const summary of await session.summaries(works.slice(offset, offset + 64))) {
      if (summary.status === 'available' && summary.type === 'work') readable.add(summary.reference);
    }
  }
  const rows = works.length ? await session.query(`SELECT ?work ?main WHERE {
    VALUES ?work { ${works.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?work rv:mainVersion ?main . ?main a rv:MainVersion ; rv:work ?work }
  } LIMIT ${works.length + 1}`, works.length + 1) : [];
  const main = new Map<string, string>();
  for (const row of rows) {
    if (!row.work || !row.main || main.has(row.work.value)) throw new WorkReadUnavailable('Work Main Version is ambiguous');
    main.set(row.work.value, row.main.value);
  }
  const visible = entries.filter(entry => coveredWorks(entry.record).every(work => readable.has(work) && main.has(work)));
  const fenced = [...new Set(visible.flatMap(entry => coveredWorks(entry.record)))];
  for (let offset = 0; offset < fenced.length; offset += 64) {
    for (const summary of await session.summaries(fenced.slice(offset, offset + 64))) {
      if (summary.status !== 'available') readable.delete(summary.reference);
    }
  }
  return visible.filter(entry => coveredWorks(entry.record).every(work => readable.has(work)))
    .map(entry => viewOf(entry.record, entry.revision, entry.snapshots, main));
}

function parseRecord(raw: string, work: string, release: string): AnyReleaseRecord {
  try {
    const record = parseStoredRelease(raw);
    if (!coveredWorks(record).includes(work)) throw new WorkReadUnavailable('Release Work differs');
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
  const rows = await session.query(`SELECT DISTINCT ?release ?revision WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?release a rv:Release ; rv:work|rv:coverageWork ${iri(work)} ; rv:releaseHead ?revision .
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
      rv:modelRevision ?profile ; rv:releaseState ?state . VALUES ?profile { ${iri(RELEASE_PROFILE)} ${iri(RELEASE_V2_PROFILE)} } }
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
  const views = await completeViews(session, records.map(record => ({ record,
    revision: byRelease.get(record.id)!.revision!.value, snapshots: snapshots.get(record.id) ?? [] })));
  return pageResult(session, views, rows.length > limit
    ? encodeReadCursor(binding, session.position, page.at(-1)!.release!.value) : null);
}

export async function readWorkRelease(session: WorkReadSession, work: string, release: string) {
  const basis = await readWorkBasis(session, work);
  const rows = await session.query(`SELECT DISTINCT ?revision ?state WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(release)} a rv:Release ; rv:work|rv:coverageWork ${iri(work)} ; rv:releaseHead ?revision }
    GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ReleaseRevision ; rv:component ${iri(release)} ;
      rv:modelRevision ?profile ; rv:releaseState ?state . VALUES ?profile { ${iri(RELEASE_PROFILE)} ${iri(RELEASE_V2_PROFILE)} } }
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
  const view = (await completeViews(session, [{ record, revision: rows[0].revision.value, snapshots }]))[0];
  if (!view) throw new WorkReadMissing('Release is unavailable');
  return { ...view, sourcePosition: session.position };
}

export interface ReleaseLookup { isbn13?: string; provider?: string; identifier?: string }

/** Indexed identifier triples select a bounded page, followed by one state join.
 * O(R log R) candidate ordering; O(page x coverage) hydration, never title matching. */
export async function readReleasesByIdentifier(session: WorkReadSession, lookup: ReleaseLookup) {
  if (!!lookup.isbn13 === !!(lookup.provider || lookup.identifier)
    || lookup.isbn13 && (!/^97[89][0-9]{10}$/.test(lookup.isbn13) || !isbnOk(lookup.isbn13))
    || !lookup.isbn13 && !Value.Check(releaseIdentifier, { provider: lookup.provider, value: lookup.identifier })) {
    throw new InvalidRelease('Choose one valid ISBN-13 or provider-qualified identifier');
  }
  const predicate = lookup.isbn13 ? 'rv:isbn13' : 'rv:identifier';
  const value = lookup.isbn13 ?? identifierLiteral({ provider: lookup.provider!, value: lookup.identifier! });
  const binding = ['release-identifier', predicate, value];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const limit = session.options.limit ?? RELEASE_V2_COST.page;
  const rows = await session.query(`SELECT ?release ?revision WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?release a rv:Release ; ${predicate} ${lit(value)} ; rv:releaseHead ?revision }
    ${cursor ? `FILTER(STR(?release) > ${lit(cursor.after)})` : ''}
  } ORDER BY STR(?release) LIMIT ${limit + 1}`, limit + 1);
  if (rows.some(row => !row.release || !row.revision)
    || new Set(rows.map(row => row.release!.value)).size !== rows.length) throw new WorkReadUnavailable('Release identities are ambiguous');
  const page = rows.slice(0, limit);
  const hydrated = page.length ? await session.query(`SELECT ?release ?revision ?state WHERE {
    VALUES (?release ?revision) { ${page.map(row => `(${iri(row.release!.value)} ${iri(row.revision!.value)})`).join(' ')} }
    GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ReleaseRevision ; rv:component ?release ;
      rv:modelRevision ?profile ; rv:releaseState ?state .
      VALUES ?profile { ${iri(RELEASE_PROFILE)} ${iri(RELEASE_V2_PROFILE)} } }
  } LIMIT ${page.length + 1}`, page.length + 1) : [];
  if (hydrated.length !== page.length || new Set(hydrated.map(row => row.release?.value)).size !== page.length) {
    throw new WorkReadUnavailable('Release lookup is incomplete');
  }
  const entries = hydrated.map(row => {
    if (!row.release || !row.revision || !row.state) throw new WorkReadUnavailable('Release lookup is incomplete');
    const record = parseStoredRelease(row.state.value);
    if (record.id !== row.release.value || (lookup.isbn13 ? record.isbn13 !== lookup.isbn13
      : record.profile !== 'release-v2' || !record.identifiers.some(entry => identifierLiteral(entry) === value))) {
      throw new WorkReadUnavailable('Release identifier projection differs');
    }
    return { record, revision: row.revision.value, snapshots: [] };
  });
  const views = await completeViews(session, entries);
  return pageResult(session, views, rows.length > limit
    ? encodeReadCursor(binding, session.position, page.at(-1)!.release!.value) : null);
}

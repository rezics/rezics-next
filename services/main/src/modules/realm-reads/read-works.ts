import { GRAPHS, WORK_SEMANTIC_TYPES, iri, lit } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, publicWork,
  WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { readRealmBasis } from './read-realm.ts';
import type { Static } from 'typebox';
import { realmWork } from './read-contract.ts';
import { readSerialSummaries } from '../work/summary-serial.ts';

type RealmWork = Static<typeof realmWork>;

/** Select the public Realm population before the bounded summary/type hydration.
 * Two basis probes, one relation query, one type batch, two summary batches and two
 * graph-position fences give O(P) hydration for P ≤ 20. Jena can still scan/sort
 * all D adopted Works: O(D log D) is the conservative discovery bound. */
export async function readRealmWorks(session: WorkReadSession, realm: string) {
  await readRealmBasis(session, realm);
  const limit = session.options.limit ?? 20;
  const binding = ['realm-works-v1', realm, session.options.language ?? null];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const rows = await session.query(`SELECT DISTINCT ?work ?head ?main ?selection ?contribution ?language WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ?slot a rv:RealmPublicationSlot ; rv:realm ${iri(realm)} ; rv:work ?work ;
        rv:mainVersion ?main ; rv:selectionHead ?selection .
      ?work rv:head ?head .
      ?contribution rv:publicationHead ?decision . }
    GRAPH ${iri(GRAPHS.revisions)} { ?selection a rv:PublicationSelection ;
      rv:component ?slot ; rv:context ${iri(realm)} ; rv:work ?work ;
      rv:mainVersion ?main ; rv:contribution ?contribution ;
      rv:publicationDecision ?decision ; rv:selectedDraft ?draft ; rv:language ?language .
      ?decision rv:disclosure rv:Public .
      FILTER NOT EXISTS { ?draft a rv:ErasedRevision } }
    ${publicWork('?work', '?main')}
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?work schema:isPartOf ?book } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
      ?chapterStructure a rv:Structure ; rv:structureProfile rv:BookComposition ;
        rv:selectedGeneration ?chapterGeneration .
      ?chapterPlacement a rv:OccurrencePlacement ; rv:generation ?chapterGeneration ;
        rv:occurrenceRole rv:ChapterRole ; schema:item ?work .
      FILTER NOT EXISTS { ?chapterPlacement rv:removedBy ?chapterRemoval }
    } }
    ${cursor ? `FILTER(STR(?work) > ${lit(cursor.after)})` : ''}
  } ORDER BY STR(?work) LIMIT ${limit + 1}`, limit + 1);
  if (rows.some(row => !row.work || !row.head || !row.main || !row.selection
    || !row.contribution || !row.language)
    || new Set(rows.map(row => row.work!.value)).size !== rows.length) {
    throw new WorkReadUnavailable('Realm Work relation is ambiguous');
  }
  const page = rows.slice(0, limit);
  const ids = page.map(row => row.work!.value);
  const summaries = await session.summaries(ids);
  const serial = await readSerialSummaries(session, ids.filter((id, index) =>
    summaries[index]?.status === 'available' && summaries[index]?.disclosure === 'public'
    && summaries[index]?.type === 'work'));
  const typeRows = ids.length ? await session.query(`SELECT ?work ?type WHERE {
    VALUES ?work { ${ids.map(iri).join(' ')} }
    VALUES ?type { ${WORK_SEMANTIC_TYPES.map(type => `<${type}>`).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?work a ?type }
  } LIMIT 161`, 160) : [];
  const fenced = await session.summaries(ids);
  const types = new Map<string, string[]>();
  for (const row of typeRows) {
    if (!row.work || !row.type || !ids.includes(row.work.value)) {
      throw new WorkReadUnavailable('Realm Work type relation is incomplete');
    }
    const list = types.get(row.work.value) ?? [];
    list.push(row.type.value);
    types.set(row.work.value, list);
  }
  const items: RealmWork[] = page.flatMap((row, index) => {
    const summary = summaries[index];
    if (summary?.status !== 'available' || summary.disclosure !== 'public'
      || fenced[index]?.status !== 'available' || fenced[index]?.disclosure !== 'public') return [];
    return [{ id: row.work!.value, revision: row.head!.value, mainVersion: row.main!.value,
      selection: row.selection!.value, contribution: row.contribution!.value,
      language: row.language!.value, title: summary.name, cover: summary.avatar,
      types: (types.get(row.work!.value) ?? []).sort(), ...serial.get(row.work!.value)! }];
  });
  await readRealmBasis(session, realm);
  const last = page.at(-1);
  return { profile: 'realm-works-v1' as const,
    ...pageResult(session, items, rows.length > limit && last
      ? encodeReadCursor(binding, session.position, last.work!.value) : null) };
}

import { GRAPHS, WORK_SEMANTIC_TYPES, iri, lit } from '../work/activate.ts';
import {
  decodeReadCursor,
  encodeReadCursor,
  pageResult,
  publicWork,
  WorkReadMoved,
  WorkReadUnavailable,
  type ReadRow,
  type WorkReadSession,
} from '../work/read-session.ts';
import { admittedPage } from '../disclosure/admitted-page.ts';
import { readRealmBasis } from './read-realm.ts';
import type { Static } from 'typebox';
import { realmWork } from './read-contract.ts';
import { readSerialSummaries } from '../work/summary-serial.ts';
import { realmHistoryOriginFilter } from '../realm-admin/history.ts';

type RealmWork = Static<typeof realmWork>;

/** Select the public Realm population before the bounded summary/type hydration.
 * Two basis probes, at most 64 identity/admission batches, one type batch,
 * two summary batches and graph-position fences give O(P) hydration for P ≤ 20. Jena can still scan/sort
 * all D adopted Works: O(D log D) is the conservative discovery bound. */
export async function readRealmWorks(session: WorkReadSession, realm: string) {
  await readRealmBasis(session, realm);
  const history = await realmHistoryOriginFilter(session, realm, 'selection', '?work');
  const limit = session.options.limit ?? 20;
  const binding = ['realm-works-v1', realm, session.options.language ?? null];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const selected = await admittedPage<ReadRow>({
    limit,
    after: cursor ? { work: { type: 'uri', value: cursor.after } } : undefined,
    key: (row) => row.work!.value,
    fetch: async (after, size) => {
      const rows = await session.query(
        `SELECT DISTINCT ?work ?head ?main ?selection ?contribution ?language WHERE {
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
    ${history}
    ${publicWork('?work', '?main')}


    ${after ? `FILTER(STR(?work) > ${lit(after.work!.value)})` : ''}
  } ORDER BY STR(?work) LIMIT ${size}`,
        size,
      );
      if (
        rows.some(
          (row) =>
            !row.work ||
            !row.head ||
            !row.main ||
            !row.selection ||
            !row.contribution ||
            !row.language,
        ) ||
        new Set(rows.map((row) => row.work!.value)).size !== rows.length
      ) {
        throw new WorkReadUnavailable('Realm Work relation is ambiguous');
      }
      return rows;
    },
    admit: async (rows) => {
      const decisions = await session.disclosure(
        rows.map((row) => ({
          owner: 'graph',
          resource: row.work!.value,
          component: 'name',
          revision: row.head!.value,
          work: row.work!.value,
          workRevision: row.head!.value,
        })),
        'read',
      );
      return rows.filter((_, index) => decisions[index] === 'visible');
    },
  });
  const page = selected.page;
  const ids = page.map((row) => row.work!.value);
  const summaries = await session.summaries(ids);
  const serial = await readSerialSummaries(
    session,
    ids.filter(
      (id, index) =>
        summaries[index]?.status === 'available' &&
        summaries[index]?.disclosure === 'public' &&
        summaries[index]?.type === 'work',
    ),
  );
  const typeRows = ids.length
    ? await session.query(
        `SELECT ?work ?type WHERE {
    VALUES ?work { ${ids.map(iri).join(' ')} }
    VALUES ?type { ${WORK_SEMANTIC_TYPES.map((type) => `<${type}>`).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?work a ?type }
  } LIMIT 161`,
        160,
      )
    : [];
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
    if (
      summary?.status !== 'available' ||
      summary.disclosure !== 'public' ||
      fenced[index]?.status !== 'available' ||
      fenced[index]?.disclosure !== 'public'
    ) {
      throw new WorkReadMoved('Realm Work admission changed');
    }
    return [
      {
        id: row.work!.value,
        revision: row.head!.value,
        mainVersion: row.main!.value,
        selection: row.selection!.value,
        contribution: row.contribution!.value,
        language: row.language!.value,
        title: summary.name,
        cover: summary.avatar,
        types: (types.get(row.work!.value) ?? []).sort(),
        ...serial.get(row.work!.value)!,
      },
    ];
  });
  await readRealmBasis(session, realm);
  const last = page.at(-1);
  return {
    profile: 'realm-works-v1' as const,
    ...pageResult(
      session,
      items,
      selected.lookahead && last
        ? encodeReadCursor(binding, session.position, last.work!.value)
        : null,
    ),
  };
}

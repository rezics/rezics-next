import type { Pool } from 'pg';
import type { AdmissionYield } from '../http/admission.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readReleasedIdentityMappingsInSnapshot } from '../semantic/identity-adapters/identity-epoch-read.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { admitCanonicalKeyset, type CanonicalKeysetAdmission, type SearchIdentityMapping } from './canonical-keyset.ts';
import { holdsCurrentType } from './current-leaf.ts';
import type { SearchDisclosureApplication } from './disclosure-application.ts';
import type { SearchHit } from './query.ts';
import type { IndexedSubject, SubjectSource } from './source.ts';
import type { PublicSearchPage } from './service-contract.ts';
import { publicHitFigures } from './public-figures.ts';

type CandidateResult = {
  canonical: CanonicalKeysetAdmission<IndexedSubject>;
  checked: Map<SearchHit, IndexedSubject>;
};
export type BookCandidateRead = {
  owner: object;
  pool: Pool;
  source: SubjectSource;
  disclosure: SearchDisclosureApplication;
  hits: readonly SearchHit[];
  types: readonly string[];
  admit: AdmissionYield;
  answer: PromiseWithResolvers<CandidateResult>;
};

async function bookCandidateSource(source: SubjectSource, hits: readonly SearchHit[]): Promise<SubjectSource> {
  if (!source.readBookCandidateNames) return source;
  const keys = new Map<number, Set<string>>();
  for (const { id, partition } of hits) {
    const route = routeOf(id);
    if (route === null || partitionOf(route) !== partition) continue;
    const ids = keys.get(partition) ?? new Set();
    ids.add(id);
    keys.set(partition, ids);
  }
  const snapshots = await source.readBookCandidateNames([...keys.values()].flatMap((ids) => [...ids]));
  if (!snapshots) return source;
  if (snapshots.size !== keys.size) throw new Error('Incomplete Book candidate snapshot');
  for (const [partition, ids] of keys) {
    const snapshot = snapshots.get(partition);
    if (!snapshot || snapshot.subjects.some(({ id }) => !ids.has(id)))
      throw new Error('Invalid Book candidate snapshot keys');
  }
  return {
    count: source.count.bind(source),
    async read(partition, ids) {
      const snapshot = snapshots.get(partition)!;
      const wanted = new Set(ids);
      return { ...snapshot, subjects: snapshot.subjects.filter(({ id }) => wanted.has(id)) };
    },
  };
}

/** One current Source window across the retained lists. Keep the original hit objects:
 * their native positions, revisions, and per-list canonical traversal still belong to each list. */
export async function readBookCandidates(waiting: BookCandidateRead[], check: () => void) {
  const settled = new Map<BookCandidateRead, () => void>();
  for (const reads of Map.groupBy(waiting, (read) => read.owner).values()) {
    const first = reads[0]!;
    try {
      const results = await first.admit(async () => {
        check();
        const hits = reads.flatMap((read) => read.hits);
        const source = await bookCandidateSource(first.source, hits);
        const { passed } = await first.disclosure.checkHits(source, hits, new Map());
        const visible = new Map(passed.map(({ hit, subject }) => [hit, subject]));
        const lists = reads.map(({ hits, types }) => {
          const selected = new Map<SearchHit, IndexedSubject>();
          for (const hit of hits) {
            const subject = visible.get(hit);
            if (subject && holdsCurrentType(subject.type, { facet: 'type', values: types })) selected.set(hit, subject);
          }
          return selected;
        });
        const originals = [...new Set(lists.flatMap((list) => Array.from(list.values(), ({ id }) => id)))];
        check();
        const mappings = new Map<string, SearchIdentityMapping>();
        if (originals.length)
          await withReadTransaction(first.pool, async (client) => {
            for (let offset = 0; offset < originals.length; offset += 100) {
              const keys = originals.slice(offset, offset + 100);
              const page = await readReleasedIdentityMappingsInSnapshot(client, keys);
              if (page.mappings.length !== keys.length) throw new Error('Incomplete Book identity mapping batch');
              keys.forEach((id, i) => mappings.set(id, page.mappings[i]!));
            }
          });
        return lists.map((list): CandidateResult => {
          const selected = [...list.values()];
          const canonical = admitCanonicalKeyset(
            selected,
            selected.map(({ id }) => mappings.get(id)!),
          );
          const checked = new Map<SearchHit, IndexedSubject>();
          if (canonical.status === 'ready')
            for (const [hit, subject] of list) if (canonical.accepted.has(subject)) checked.set(hit, subject);
          return { canonical, checked };
        });
      });
      reads.forEach((read, i) => settled.set(read, () => read.answer.resolve(results[i]!)));
    } catch (error) {
      for (const read of reads) settled.set(read, () => read.answer.reject(error));
    }
  }
  return settled;
}

type BookHit = Omit<PublicSearchPage['subjects'][number], 'figure'>;
export type BookFigureRead = {
  pool: Pool;
  hits: readonly BookHit[];
  admit: AdmissionYield;
  answer: PromiseWithResolvers<PublicSearchPage['subjects']>;
};

/** Figures depend on the kept subject key. Match evidence and chosen labels belong to the list. */
export async function readBookFigures(waiting: BookFigureRead[], check: () => void) {
  const settled = new Map<BookFigureRead, () => void>();
  for (const [pool, reads] of Map.groupBy(waiting, (read) => read.pool)) {
    try {
      check();
      const unique = new Map(reads.flatMap((read) => read.hits.map((hit) => [hit.id, hit] as const)));
      const rows = await reads[0]!.admit(() => publicHitFigures(pool, [...unique.values()]));
      const figures = new Map(rows.map(({ id, figure }) => [id, figure]));
      for (const read of reads) {
        const result = read.hits.map((hit) => ({ ...hit, figure: figures.get(hit.id)! }));
        settled.set(read, () => read.answer.resolve(result));
      }
    } catch (error) {
      for (const read of reads) settled.set(read, () => read.answer.reject(error));
    }
  }
  return settled;
}

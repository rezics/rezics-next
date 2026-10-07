import { cache } from 'react';
import type { UiLocale } from '../../../i18n/define.ts';
import { workTitle } from '../../catalogue/work-tile.tsx';
import type { MainClient } from '../../discover/types.ts';
import { type Loaded, settle } from '../../feed/types.ts';
import { libraryReader, statusShelfItems } from '../read.ts';
import { statusShelves } from '../state.ts';
import { asCopy, asLoan, asRelease } from './shape.ts';
import type { CopyRecord, LoanListItem, LoanRecord, ReleaseChoice } from './types.ts';

// The loan list names a copy, not the Work. Titles come from the reader's
// shelves: each shelf page's Works are asked for their copies until every
// loan on this page is named or the lookup budget is spent. A loan whose
// copy is not among those Works still shows its counterparty and due date.

const SHELF_PAGES = 2;
const COPY_LOOKUPS = 24;
const uuid = (iri: string) => iri.slice(-36);

export interface LoansPageData {
  items: LoanListItem[];
  nextCursor: string | null;
  complete: boolean;
}

interface CopyLabel { work: { id: string; href: string; title: string }; edition: string | null; format: string | null }

async function pooled<T>(items: readonly T[], task: (item: T) => Promise<void>, limit: number): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await task(items[index]!);
    }
  }));
}

/** Active loans for the reader, oldest due date first, with the Work each copy belongs to when it can be found. */
export const readLoans = cache(async (cursor: string | null, locale: UiLocale): Promise<Loaded<LoansPageData>> => {
  const reader = await libraryReader();
  if (!reader) return { ok: false, failure: 'sign-in' };
  const read = await settle(() => reader.main.v1.me['library-loans'].get({ query: {
    actingSubject: reader.actingSubject, state: 'active', limit: 20, ...(cursor ? { cursor } : {}) } }));
  if (!read.ok) return read;
  const loans = read.data.items.flatMap(item => {
    const loan = asLoan(item);
    return loan ? [loan] : [];
  });
  const [labels, people] = await Promise.all([
    labelCopies(reader.main, reader.actingSubject, loans, locale),
    personNames(reader.main, reader.actingSubject, loans),
  ]);
  return { ok: true, data: { items: loans.map(loan => ({ loan, work: labels.get(loan.copy)?.work ?? null,
    edition: labels.get(loan.copy)?.edition ?? null, format: labels.get(loan.copy)?.format ?? null,
    personName: loan.counterparty.kind === 'person' ? people.get(loan.counterparty.person) ?? null : null })),
  nextCursor: read.data.nextCursor, complete: read.data.complete } };
});

async function labelCopies(main: MainClient, actingSubject: string, loans: readonly LoanRecord[],
  locale: UiLocale): Promise<Map<string, CopyLabel>> {
  const wanted = new Set(loans.map(loan => loan.copy));
  const labels = new Map<string, CopyLabel>();
  let lookups = 0;
  const seenWorks = new Set<string>();
  for (const status of statusShelves) {
    if (labels.size === wanted.size || lookups >= COPY_LOOKUPS) break;
    let cursor: string | undefined;
    for (let page = 0; page < SHELF_PAGES && labels.size < wanted.size && lookups < COPY_LOOKUPS; page++) {
      const shelf = await settle(() => main.v1.me.shelves.status({ status }).works.get({ query: {
        actingSubject, sort: 'added', order: 'desc', limit: 20, ...(cursor ? { cursor } : {}) } }));
      if (!shelf.ok) break;
      const works = statusShelfItems(shelf.data.items).filter(item => !seenWorks.has(item.work.id));
      for (const item of works) seenWorks.add(item.work.id);
      await pooled(works, async item => {
        if (labels.size === wanted.size || lookups >= COPY_LOOKUPS) return;
        lookups += 1;
        const copies = await settle(() => main.v1.works({ id: uuid(item.work.id) }).copies.get({ query: {
          actingSubject, limit: 20 } }));
        if (!copies.ok) return;
        for (const raw of copies.data.items) {
          const copy = asCopy(raw);
          if (!copy || !wanted.has(copy.id) || labels.has(copy.id)) continue;
          const edition = await editionLine(main, actingSubject, copy);
          labels.set(copy.id, { work: { id: item.work.id, href: item.work.href, title: workTitle(item.work, locale) },
            edition, format: copy.format });
        }
      }, 6);
      if (!shelf.data.nextCursor) break;
      cursor = shelf.data.nextCursor;
    }
  }
  return labels;
}

async function editionLine(main: MainClient, actingSubject: string, copy: CopyRecord): Promise<string | null> {
  const read = await settle(() => main.v1.works({ id: uuid(copy.work) }).releases({ release: uuid(copy.release) }).get({
    query: { actingSubject } }));
  if (!read.ok) return null;
  const release: ReleaseChoice | null = asRelease(read.data);
  if (!release) return null;
  const detail = [release.editionStatement, release.publicationYear, release.isbn13].filter(part => part != null)
    .join(' · ');
  return detail ? `${release.title} — ${detail}` : release.title;
}

async function personNames(main: MainClient, actingSubject: string, loans: readonly LoanRecord[]):
  Promise<Map<string, string>> {
  const ids = [...new Set(loans.flatMap(loan => loan.counterparty.kind === 'person' ? [loan.counterparty.person] : []))];
  const names = new Map<string, string>();
  await pooled(ids, async id => {
    const read = await settle(() => main.v1.agents({ id: uuid(id) }).get({ query: { actingSubject } }));
    if (read.ok && read.data.kind === 'person' && read.data.displayName) names.set(id, read.data.displayName);
  }, 6);
  return names;
}

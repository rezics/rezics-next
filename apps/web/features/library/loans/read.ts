import { cache } from 'react';
import type { UiLocale } from '../../../i18n/define.ts';
import type { MainClient } from '../../discover/types.ts';
import { type Loaded, settle } from '../../feed/types.ts';
import { libraryReader } from '../read.ts';
import { workHref } from '../../work-page/route.ts';
import { collectCopies, loanLabels, type CopyLabel } from './identity.ts';
import { asCopy, asLoan, asRelease } from './shape.ts';
import type { CopyRecord, LoanListItem, LoanRecord } from './types.ts';

// The loan list names a copy. That copy's own record names the Work and the
// release, so the label does not depend on which shelf the Work sits on.
// The private library export is the read that returns those copy records.
// One loan page asks only for its own copies, and stops once they are named.

export interface LoansPageData {
  items: LoanListItem[];
  nextCursor: string | null;
  complete: boolean;
}

async function pooled<T>(items: readonly T[], task: (item: T) => Promise<void>, limit: number): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await task(items[index]!);
    }
  }));
}

/** Active loans for the reader, oldest due date first, with the Work each copy belongs to when it can be read. */
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

const uuid = (iri: string) => iri.slice(-36);

async function copyPages(main: MainClient, actingSubject: string, wanted: ReadonlySet<string>):
  Promise<Map<string, CopyRecord>> {
  let last = new Map<string, CopyRecord>();
  for (let attempt = 0; attempt < 2; attempt++) {
    let snapshot: string | undefined;
    let moved = false;
    const found = await collectCopies(wanted, async cursor => {
      const answer = await main.v1.me['library-export'].get({ query: { actingSubject, limit: 20,
        ...(snapshot ? { snapshot } : {}), ...(cursor ? { cursor } : {}) } }).catch(() => null);
      if (!answer?.data) {
        moved = answer?.status === 409;
        return null;
      }
      snapshot = answer.data.snapshot;
      const copies: CopyRecord[] = [];
      let copiesEnded = false;
      for (const row of answer.data.rows) {
        if (row.sourceId.startsWith('loan:')) copiesEnded = true;
        const copy = asCopy(row.raw.libraryCopy);
        if (copy) copies.push(copy);
      }
      return { copies, nextCursor: copiesEnded ? null : answer.data.nextCursor };
    });
    last = found;
    if (!moved || found.size === wanted.size) return found;
  }
  return last;
}

async function labelCopies(main: MainClient, actingSubject: string, loans: readonly LoanRecord[], locale: UiLocale):
  Promise<Map<string, CopyLabel>> {
  if (!loans.length) return new Map();
  const copies = await copyPages(main, actingSubject, new Set(loans.map(loan => loan.copy)));
  return loanLabels(loans, {
    copy: async id => copies.get(id) ?? null,
    async work(id) {
      const read = await settle(() => main.v1.works({ id: uuid(id) }).get({ query: { actingSubject, language: locale } }));
      const title = read.ok ? read.data.title?.value : null;
      return title ? { id, href: workHref(id), title } : null;
    },
    async release(work, release) {
      const read = await settle(() => main.v1.works({ id: uuid(work) }).releases({ release: uuid(release) }).get({
        query: { actingSubject } }));
      return read.ok ? asRelease(read.data) : null;
    },
  });
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

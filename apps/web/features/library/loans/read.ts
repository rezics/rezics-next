import { cache } from 'react';
import type { UiLocale } from '../../../i18n/define.ts';
import { isOfflineError } from '../../feed/types.ts';
import { libraryReader } from '../read.ts';
import { loansWithLabels, refusedLoansRead, type LoansPageData, type LoansPageRead, type LoansSource } from './books-loans-recorded-page.ts';
import { asLoan } from './shape.ts';

export type { LoansPageData, LoansPageRead, LoansSource };

/**
 * Active loans for the session's Person, oldest due date first. A caller may
 * pass the client the page would use. Overdue stays overdue: a past due date
 * is not a return. The list is this loans read, not the copies in an export.
 */
export const readLoans = cache(async (cursor: string | null, locale: UiLocale, source?: LoansSource):
  Promise<LoansPageRead> => {
  const reader = source ?? await libraryReader();
  if (!reader) return { ok: false, failure: 'sign-in' };
  const { main, actingSubject } = reader;
  let transport: 'offline' | 'unavailable' | null = null;
  const read = await main.v1.me['library-loans'].get({ query: {
    actingSubject, state: 'active', limit: 20, ...(cursor ? { cursor } : {}) } }).catch((error: unknown) => {
    transport = isOfflineError(error) ? 'offline' : 'unavailable';
    return null;
  });
  if (!read || transport) return { ok: false, failure: transport ?? 'unavailable' };
  if (read.error) return refusedLoansRead(read.error.status, read.error.value, read.headers ?? read.response?.headers);
  if (read.data == null) return { ok: false, failure: 'unavailable' };
  const loans = read.data.items.flatMap(item => {
    const loan = asLoan(item);
    return loan ? [loan] : [];
  });
  return { ok: true, data: { items: await loansWithLabels(reader, loans, locale),
    nextCursor: read.data.nextCursor, complete: read.data.complete } };
});

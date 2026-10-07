'use client';

import { Badge } from '@rezics/ui/badge';
import { Button, buttonVariants } from '@rezics/ui/button';
import { HandshakeIcon, TriangleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useState } from 'react';
import type { UiLocale } from '../../../i18n/define.ts';
import { Notice } from '../../discover/notice.tsx';
import { EmptyState } from '../../shell/empty-state.tsx';
import Link from '../../shell/localized-link.tsx';
import type { LibraryMessages } from '../messages.ts';
import { ExtendDialog, ReturnDialog } from './dialogs.tsx';
import { formatDue } from './format.ts';
import { counterpartyLabel } from './party.ts';
import type { LoanListItem, LoanRecord } from './types.ts';

/**
 * Loans beside the shelves: overdue first, then what is still due, each with
 * Return and Extend. Names typed by the reader are shown as stored.
 */
export function LoansView({ items, nextCursor, failure, cursor, locale, messages }: {
  items: readonly LoanListItem[]; nextCursor: string | null; failure: string | null; cursor: string | null;
  locale: UiLocale; messages: LibraryMessages;
}) {
  const t = materializeData(messages, { locale });
  const signature = items.map(item => `${item.loan.id}:${item.loan.version}:${item.loan.state}`).join('|');
  const [seen, setSeen] = useState(signature);
  const [rows, setRows] = useState(items);
  const [note, setNote] = useState<string | null>(null);
  if (signature !== seen) {
    setSeen(signature);
    setRows(items);
  }
  const overdue = rows.filter(item => item.loan.state === 'overdue');
  const due = rows.filter(item => item.loan.state === 'open');

  function apply(loan: LoanRecord, done: string) {
    setRows(current => loan.state === 'returned' ? current.filter(item => item.loan.id !== loan.id)
      : current.map(item => item.loan.id === loan.id ? { ...item, loan } : item));
    setNote(done);
  }

  return <section aria-labelledby="library-loans" className="grid min-w-0 gap-5">
    <header className="grid gap-1 border-border/70 border-b pb-4">
      <h2 id="library-loans" className="font-semibold text-2xl tracking-tight">{t.loans}</h2>
      <p className="text-pretty text-muted-foreground text-sm">{t.loansPrivate}</p>
    </header>
    {note ? <p role="status" className="rounded-xl bg-muted px-4 py-2.5 text-sm">{note}</p> : null}
    {failure ? <Notice icon={TriangleAlertIcon} tone="destructive" headingLevel={3} title={t.loansUnavailable}>
      <Link href="/library/loans" className={buttonVariants({ size: 'sm', variant: 'outline' })}>{t.retry}</Link>
    </Notice> : !overdue.length && !due.length ? <EmptyState icon={HandshakeIcon} title={t.loansEmpty}
      description={t.loansEmptyBody} /> : <div className="grid gap-8">
      <LoanGroup title={t.overdue} items={overdue} overdue locale={locale} messages={messages}
        onReturned={loan => apply(loan, t.loanReturned)} onExtended={loan => apply(loan, t.loanExtended)} />
      <LoanGroup title={t.dueSoon} items={due} locale={locale} messages={messages}
        onReturned={loan => apply(loan, t.loanReturned)} onExtended={loan => apply(loan, t.loanExtended)} />
    </div>}
    {cursor || nextCursor ? <nav aria-label={t.pages} className="flex flex-wrap items-center justify-between gap-3">
      {cursor ? <Link href="/library/loans" className={buttonVariants({ variant: 'outline' })}>{t.firstPage}</Link> : <span />}
      {nextCursor ? <Link href={`/library/loans?cursor=${encodeURIComponent(nextCursor)}`} rel="next"
        className={buttonVariants({ variant: 'outline' })}>{t.nextPage}</Link> : <span />}
    </nav> : null}
  </section>;
}

function LoanGroup({ title, items, overdue = false, locale, messages, onReturned, onExtended }: {
  title: string; items: readonly LoanListItem[]; overdue?: boolean; locale: UiLocale; messages: LibraryMessages;
  onReturned: (loan: LoanRecord) => void; onExtended: (loan: LoanRecord) => void;
}) {
  const heading = overdue ? 'library-loans-overdue' : 'library-loans-due';
  if (!items.length) return null;
  return <section aria-labelledby={heading} className="grid gap-3">
    <h3 id={heading} className="font-semibold text-lg tracking-tight">{title}</h3>
    <ul className="grid gap-3">
      {items.map(item => <LoanCard key={item.loan.id} item={item} overdue={overdue} locale={locale}
        messages={messages} onReturned={onReturned} onExtended={onExtended} />)}
    </ul>
  </section>;
}

function LoanCard({ item, overdue, locale, messages, onReturned, onExtended }: {
  item: LoanListItem; overdue: boolean; locale: UiLocale; messages: LibraryMessages;
  onReturned: (loan: LoanRecord) => void; onExtended: (loan: LoanRecord) => void;
}) {
  const t = materializeData(messages, { locale });
  const [extend, setExtend] = useState(false);
  const [returning, setReturning] = useState(false);
  const name = counterpartyLabel(item.loan.counterparty, item.personName, t.unnamedPerson);
  const facts = [item.format, item.edition].filter((fact): fact is string => Boolean(fact));
  return <li className={overdue
    ? 'grid min-w-0 gap-3 rounded-2xl border border-destructive/30 bg-destructive/10 p-4'
    : 'grid min-w-0 gap-3 rounded-2xl bg-muted/50 p-4'}>
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
      <h4 className="min-w-0 text-pretty font-medium text-lg/snug [overflow-wrap:anywhere]">
        {item.work?.title ? <Link href={item.work.href} className="rounded-sm outline-none hover:underline
          focus-visible:ring-2 focus-visible:ring-ring">{item.work.title}</Link> : t.unnamedCopy}
      </h4>
      {overdue ? <Badge variant="destructive" pill>{t.overdue}</Badge> : null}
    </div>
    <p className="text-pretty [overflow-wrap:anywhere]">{item.loan.direction === 'lent' ? t.lentTo({ name })
      : t.borrowedFrom({ name })}</p>
    {facts.length ? <p className="text-pretty text-muted-foreground text-sm [overflow-wrap:anywhere]">{facts.join(' · ')}</p> : null}
    <p className="font-medium text-sm tabular-nums">{t.dueOn({ date: formatDue(item.loan.dueAt, locale) })}</p>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" onClick={() => setReturning(true)}>{t.returnLoan}</Button>
      <Button size="sm" variant="outline" onClick={() => setExtend(true)}>{t.extendLoan}</Button>
    </div>
    <ReturnDialog loan={item.loan} open={returning} onOpenChange={setReturning} locale={locale} messages={messages}
      onSaved={onReturned} />
    <ExtendDialog loan={item.loan} open={extend} onOpenChange={setExtend} locale={locale} messages={messages}
      onSaved={onExtended} />
  </li>;
}

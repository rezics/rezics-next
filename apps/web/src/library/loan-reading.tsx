import { pickText } from '@rezics/composition';
import type { Loan } from '@rezics/client';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { LoansPageData, LoanWriteResult } from './loans-read';

export type LoanItem = LoansPageData['items'][number];
export const loanButton =
  'min-h-11 min-w-11 inline-flex max-w-full items-center justify-center whitespace-normal rounded-lg bg-primary px-4 py-2 text-center font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60';
export const loanQuiet =
  'min-h-11 min-w-11 inline-flex max-w-full items-center justify-center whitespace-normal rounded-lg border border-border px-4 py-2 text-center hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60';
export const loanField =
  'min-h-11 min-w-0 w-full rounded-lg border border-border bg-background px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function loanFailure(reason: Extract<LoanWriteResult, { ok: false }>['reason']) {
  if (reason === 'conflict') return m.library_loans_conflict();
  if (reason === 'invalid') return m.library_loans_invalid();
  if (reason === 'closed') return m.library_loans_closed();
  if (reason === 'forbidden') return m.library_loans_forbidden();
  return m.library_loans_failure();
}

export function loanCounterparty(loan: Loan) {
  if (loan.counterparty.kind === 'name') return loan.counterparty.name;
  if (loan.counterparty.state === 'available') return loan.counterparty.displayName;
  return m.library_loans_counterparty_concealed();
}

export function loanCopyTitle(item: LoanItem): { text: string; lang?: string | null } {
  if (item.copy.state === 'deleted') return { text: m.library_loans_copy_deleted() };
  if (item.copy.state === 'missing') return { text: m.library_loans_copy_missing() };
  const context = item.copy.context;
  if (context.state === 'available' && context.work[0]) return pickText(context.work[0].labels, getLocale());
  if (context.state === 'withheld') return { text: m.library_loans_context_withheld() };
  if (context.state === 'scope') return { text: m.library_loans_context_scope() };
  if (context.state === 'unsupported') return { text: m.library_loans_context_unsupported() };
  return { text: m.library_subject_unavailable() };
}

/** Supplied identity only: concealed context never becomes a guessed title or destination. */
export function LoanIdentity({ item }: { item: LoanItem }) {
  const title = loanCopyTitle(item);
  return (
    <div className="min-w-0 space-y-1 [overflow-wrap:anywhere]">
      <p lang={title.lang ?? undefined} className="font-medium">
        {title.text}
      </p>
      <p className="text-sm text-muted-foreground">
        {m.library_loans_copy_id()}: <span className="font-mono">{item.loan.copyId}</span>
      </p>
    </div>
  );
}

export function LoanFacts({ loan, today }: { loan: Loan; today: string | null }) {
  const state =
    loan.state === 'returned'
      ? m.library_loans_returned()
      : loan.state === 'overdue'
        ? m.library_loans_overdue()
        : loan.state === 'undated'
          ? m.library_loans_undated()
          : loan.dueOn === today
            ? m.library_loans_due_today()
            : m.library_loans_due();
  return (
    <div className="min-w-0 space-y-3 [overflow-wrap:anywhere]">
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-medium">
          {loan.direction === 'lent' ? m.library_loans_lent() : m.library_loans_borrowed()}
        </span>
        <span className="whitespace-pre-wrap">{loanCounterparty(loan)}</span>
        <span className="rounded-md bg-muted px-2 py-1 text-sm font-medium">{state}</span>
      </p>
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">{m.library_loans_started()}</dt>
          <dd>{loan.startedOn}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{m.library_loans_due()}</dt>
          <dd>{loan.dueOn ?? m.library_loans_undated()}</dd>
        </div>
        {loan.returnedOn ? (
          <div>
            <dt className="text-muted-foreground">{m.library_loans_returned()}</dt>
            <dd>{loan.returnedOn}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

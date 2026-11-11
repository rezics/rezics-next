import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { useId, useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import type { Loan } from '@rezics/client';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { Exposure, type GatedOperation } from '../kernel/exposure';
import { pageText } from '../features/pages/shared';
import { getLocale } from '../paraglide/runtime.js';
import { CalendarDayField } from './calendar-day-field';
import type { LoansPageData, LoanWriteResult } from './loans-read';
import type { LoansAddress } from './loans-query';
import { createLoan, completeLoan, updateLoanDue } from './loans-actions';

const button =
  'min-h-11 min-w-11 inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60';
const quiet =
  'min-h-11 min-w-11 inline-flex items-center justify-center rounded-lg border border-border px-4 py-2 hover:bg-muted disabled:opacity-60';
const field =
  'min-h-11 min-w-0 w-full rounded-lg border border-border bg-background px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring';

export type LoansOrigin = {
  isCurrent: (operation?: GatedOperation) => boolean;
  headers: (operation?: GatedOperation) => HeadersInit | null;
};

function failureText(reason: Extract<LoanWriteResult, { ok: false }>['reason']) {
  if (reason === 'conflict') return m.library_loans_conflict();
  if (reason === 'invalid') return m.library_loans_invalid();
  if (reason === 'closed') return m.library_loans_closed();
  if (reason === 'forbidden') return m.library_loans_forbidden();
  return m.library_loans_failure();
}

function counterparty(loan: Loan) {
  if (loan.counterparty.kind === 'name') return loan.counterparty.name;
  if (loan.counterparty.state === 'available') return loan.counterparty.displayName;
  return m.library_loans_counterparty_concealed();
}

function copyTitle(item: LoansPageData['items'][number], locale: string) {
  const context = item.copy.context;
  if (context.state === 'available' && context.work[0]) return pageText(context.work[0].labels, locale).text;
  if (item.copy.state === 'deleted') return m.library_loans_copy_deleted();
  if (item.copy.state === 'missing') return m.library_loans_copy_missing();
  return m.library_subject_unavailable();
}

function stateLabel(loan: Loan) {
  if (loan.state === 'overdue') return m.library_loans_overdue();
  if (loan.state === 'due') return m.library_loans_due_today();
  if (loan.state === 'undated') return m.library_loans_undated();
  return m.library_loans_returned();
}

export function LoansPage({
  page,
  address,
  originating,
  onRefresh,
}: {
  page: LoansPageData;
  address: LoansAddress;
  originating: LoansOrigin;
  onRefresh: () => void;
}) {
  const locale = getLocale();
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const current = originating.isCurrent;
  async function run(
    operation: 'copy.create' | 'copy.update',
    send: (headers: HeadersInit) => Promise<LoanWriteResult>,
  ) {
    if (!current(operation) || pending) return;
    const headers = originating.headers(operation);
    if (!headers) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await send(headers);
      if (!current(operation)) return;
      if (!result.ok) {
        setFailure(failureText(result.reason));
        return;
      }
      onRefresh();
    } catch {
      if (current(operation)) setFailure(m.library_loans_failure());
    } finally {
      if (current(operation)) setPending(false);
    }
  }
  const empty =
    page.inventoryState === 'forbidden'
      ? m.library_loans_forbidden()
      : page.inventoryState === 'unavailable'
        ? m.library_loans_unavailable()
        : page.items.length
          ? null
          : address.cursor
            ? m.library_loans_page_empty()
            : address.filter === 'history'
              ? m.library_loans_history_empty()
              : m.library_loans_empty();
  return (
    <div className="max-w-4xl space-y-6 text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <PageHeading>{m.library_loans_heading()}</PageHeading>
        <Link to="/library/copies" className={`${quiet} text-primary`}>
          {m.library_loans_copies()}
        </Link>
      </header>
      <Exposure operation="copy.list">
        <nav className="flex flex-wrap gap-3" aria-label={m.library_loans_heading()}>
          <Link
            to="/library/loans"
            search={{}}
            className={address.filter === 'open' ? button : quiet}
            onClick={(event) => {
              if (!current('copy.list')) event.preventDefault();
            }}
          >
            {m.library_loans_filter_open()}
          </Link>
          <Link
            to="/library/loans"
            search={{ filter: 'history' }}
            className={address.filter === 'history' ? button : quiet}
            onClick={(event) => {
              if (!current('copy.list')) event.preventDefault();
            }}
          >
            {m.library_loans_filter_history()}
          </Link>
        </nav>
      </Exposure>
      {failure ? <p role="alert">{failure}</p> : null}
      {empty ? <p role="status">{empty}</p> : null}
      {page.items.length ? (
        <ul className="m-0 list-none space-y-4 p-0">
          {page.items.map((item) => (
            <LoanCard
              key={`${item.loan.id}:${item.loan.revision}`}
              item={item}
              locale={locale}
              today={page.boundary?.today ?? null}
              disabled={pending || !current()}
              onExtend={(dueOn) =>
                void run('copy.update', (headers) =>
                  updateLoanDue({
                    data: {
                      loanId: item.loan.id,
                      revision: item.loan.revision,
                      dueOn,
                      idempotencyKey: crypto.randomUUID(),
                    },
                    headers,
                  }),
                )
              }
              onReturn={(returnedOn) =>
                void run('copy.update', (headers) =>
                  completeLoan({
                    data: {
                      loanId: item.loan.id,
                      revision: item.loan.revision,
                      returnedOn,
                      idempotencyKey: crypto.randomUUID(),
                    },
                    headers,
                  }),
                )
              }
            />
          ))}
        </ul>
      ) : null}
      {page.next || address.cursor ? (
        <nav className="flex flex-wrap gap-3" aria-label={m.library_loans_heading()}>
          {address.cursor ? (
            <Link
              to="/library/loans"
              search={address.filter === 'history' ? { filter: 'history' } : {}}
              className={`${quiet} text-primary`}
              onClick={(event) => {
                if (!current('copy.list')) event.preventDefault();
              }}
            >
              {m.library_collections_first_page()}
            </Link>
          ) : null}
          {page.next ? (
            <Link
              to="/library/loans"
              search={{
                ...(address.filter === 'history' ? { filter: 'history' as const } : {}),
                cursor: page.next,
              }}
              className={`${quiet} text-primary`}
              onClick={(event) => {
                if (!current('copy.list')) event.preventDefault();
              }}
            >
              {m.library_loans_more()}
            </Link>
          ) : null}
        </nav>
      ) : null}
      {address.filter === 'open' && page.inventoryState !== 'forbidden' ? (
        <LoanCreateForm
          today={page.boundary?.today ?? null}
          disabled={pending}
          current={current}
          onCreate={(input) => void run('copy.create', (headers) => createLoan({ data: input, headers }))}
        />
      ) : null}
    </div>
  );
}

function LoanCard({
  item,
  locale,
  today,
  disabled,
  onExtend,
  onReturn,
}: {
  item: LoansPageData['items'][number];
  locale: string;
  today: string | null;
  disabled: boolean;
  onExtend: (dueOn: string) => void;
  onReturn: (returnedOn: string) => void;
}) {
  const [dueOn, setDueOn] = useState(item.loan.dueOn ?? '');
  const [returnedOn, setReturnedOn] = useState(today ?? '');
  const fieldsId = useId();
  return (
    <li className="min-w-0 space-y-3 border-t border-border pt-4">
      <p className="font-medium [overflow-wrap:anywhere]">{copyTitle(item, locale)}</p>
      <p className="text-sm text-muted-foreground">
        {item.loan.direction === 'lent' ? m.library_loans_lent() : m.library_loans_borrowed()}
        {' · '}
        {counterparty(item.loan)}
        {' · '}
        {stateLabel(item.loan)}
      </p>
      <dl className="grid gap-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">{m.library_loans_started()}</dt>
          <dd>{item.loan.startedOn}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{m.library_loans_due()}</dt>
          <dd>{item.loan.dueOn ?? m.library_loans_undated()}</dd>
        </div>
        {item.loan.returnedOn ? (
          <div>
            <dt className="text-muted-foreground">{m.library_loans_returned()}</dt>
            <dd>{item.loan.returnedOn}</dd>
          </div>
        ) : null}
      </dl>
      {item.loan.actions.extend.allowed ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            onExtend(dueOn);
          }}
        >
          <div className="min-w-0 flex-1">
            <CalendarDayField
              id={`${fieldsId}-due`}
              label={m.library_loans_due()}
              value={dueOn}
              min={item.loan.dueOn ?? item.loan.startedOn}
              disabled={disabled}
              required
              onChange={setDueOn}
            />
          </div>
          <button type="submit" className={button} disabled={disabled}>
            {m.library_loans_extend()}
          </button>
        </form>
      ) : null}
      {item.loan.actions.return.allowed ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            onReturn(returnedOn);
          }}
        >
          <div className="min-w-0 flex-1">
            <CalendarDayField
              id={`${fieldsId}-returned`}
              label={m.library_loans_returned()}
              value={returnedOn}
              min={item.loan.startedOn}
              max={today ?? undefined}
              disabled={disabled}
              required
              onChange={setReturnedOn}
            />
          </div>
          <button type="submit" className={button} disabled={disabled}>
            {m.library_loans_return()}
          </button>
        </form>
      ) : null}
    </li>
  );
}

function LoanCreateForm({
  today,
  disabled,
  current,
  onCreate,
}: {
  today: string | null;
  disabled: boolean;
  current: LoansOrigin['isCurrent'];
  onCreate: (input: Record<string, unknown>) => void;
}) {
  const loanDirectionSelectId = useId();
  const [copyId, setCopyId] = useState('');
  const [copyRevision, setCopyRevision] = useState('1');
  const [direction, setDirection] = useState<'lent' | 'borrowed'>('lent');
  const [name, setName] = useState('');
  const [startedOn, setStartedOn] = useState(today ?? '');
  const [dueOn, setDueOn] = useState('');
  const fieldsId = useId();
  const loanDirectionOptions = [
    { value: 'lent', label: m.library_loans_lent() },
    { value: 'borrowed', label: m.library_loans_borrowed() },
  ];
  return (
    <form
      className="space-y-3 border-t border-border pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        onCreate({
          copyId,
          copyRevision: Number(copyRevision),
          direction,
          counterparty: { kind: 'name', name },
          startedOn,
          ...(dueOn === '' ? {} : { dueOn }),
          idempotencyKey: crypto.randomUUID(),
        });
      }}
    >
      <h2 className="font-medium">{m.library_loans_create()}</h2>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className="min-w-0 space-y-1 sm:col-span-2">
          <span className="text-sm">{m.library_loans_copy_id()}</span>
          <input
            className={field}
            value={copyId}
            required
            disabled={disabled}
            onChange={(event) => current() && setCopyId(event.currentTarget.value)}
          />
        </label>
        <label className="min-w-0 space-y-1">
          <span className="text-sm">{m.library_loans_copy_revision()}</span>
          <input
            className={field}
            inputMode="numeric"
            value={copyRevision}
            required
            disabled={disabled}
            onChange={(event) => current() && setCopyRevision(event.currentTarget.value)}
          />
        </label>
        <Field className="min-w-0 gap-1">
          <FieldLabel id={`${loanDirectionSelectId}-label`} htmlFor={loanDirectionSelectId}>
            {m.library_loans_direction()}
          </FieldLabel>
          <Select<string, false>
            items={loanDirectionOptions}
            disabled={disabled}
            value={direction}
            onValueChange={(value) => {
              if ((value === 'lent' || value === 'borrowed') && current()) setDirection(value);
            }}
          >
            <SelectTrigger
              id={loanDirectionSelectId}
              aria-labelledby={`${loanDirectionSelectId}-label`}
              className={field}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                {loanDirectionOptions.map(({ value, label, ...itemProps }) => (
                  <SelectItem key={value ?? ''} value={value} {...itemProps}>
                    {label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <label className="min-w-0 space-y-1">
          <span className="text-sm">{m.library_loans_counterparty()}</span>
          <input
            className={field}
            value={name}
            maxLength={300}
            required
            disabled={disabled}
            onChange={(event) => current() && setName(event.currentTarget.value)}
          />
        </label>
        <CalendarDayField
          id={`${fieldsId}-started`}
          label={m.library_loans_started()}
          value={startedOn}
          required
          disabled={disabled}
          onChange={(value) => current() && setStartedOn(value)}
        />
        <CalendarDayField
          id={`${fieldsId}-due`}
          label={m.library_loans_due()}
          value={dueOn}
          min={startedOn}
          disabled={disabled}
          onChange={(value) => current() && setDueOn(value)}
        />
      </div>
      <button type="submit" className={button} disabled={disabled || !current('copy.create')}>
        {m.library_loans_submit()}
      </button>
    </form>
  );
}

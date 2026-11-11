import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
import type { GatedOperation } from '../kernel/exposure';
import { m } from '../paraglide/messages.js';
import { CalendarDayField } from './calendar-day-field';
import type { CopyItem } from './copies-read';
import type { OpenCopyLoanRead } from './loans-actions';
import type { LoanWriteResult, LoansPageData } from './loans-read';

const button =
  'min-h-11 min-w-11 inline-flex items-center justify-center rounded-lg bg-primary px-4 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60';
const quiet =
  'min-h-11 min-w-11 inline-flex items-center justify-center rounded-lg border border-border px-4 hover:bg-muted disabled:opacity-60';
const field =
  'min-h-11 min-w-0 w-full rounded-lg border border-border bg-background px-3 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring';

type Origin = {
  isCurrent: (operation?: GatedOperation) => boolean;
  headers: (operation?: GatedOperation) => HeadersInit | null;
};
type OpenItem = LoansPageData['items'][number];

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

function failureText(reason: Extract<LoanWriteResult, { ok: false }>['reason']) {
  if (reason === 'conflict') return m.library_loans_conflict();
  if (reason === 'invalid') return m.library_loans_invalid();
  if (reason === 'closed') return m.library_loans_closed();
  if (reason === 'forbidden') return m.library_loans_forbidden();
  return m.library_loans_failure();
}

export function CopyLoanPanel({
  copy,
  originating,
  disabled,
}: {
  copy: CopyItem;
  originating: Origin;
  disabled: boolean;
}) {
  const loanDirectionSelectId = useId();
  const formId = useId();
  const [item, setItem] = useState<OpenItem | null>(null);
  const [today, setToday] = useState(utcDay);
  const [direction, setDirection] = useState<'lent' | 'borrowed'>('lent');
  const [name, setName] = useState('');
  const [startedOn, setStartedOn] = useState(utcDay);
  const [dueOn, setDueOn] = useState('');
  const [returnedOn, setReturnedOn] = useState(utcDay);
  const [extendDue, setExtendDue] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const originatingRef = useRef(originating);
  originatingRef.current = originating;
  const current = (operation?: GatedOperation) => originatingRef.current.isCurrent(operation);
  const busy = disabled || pending;

  useEffect(() => {
    let active = true;
    void (async () => {
      if (!originatingRef.current.isCurrent('copy.list')) return;
      try {
        const { readOpenCopyLoan } = await import('./loans-actions');
        const result = (await readOpenCopyLoan({ data: { copyId: copy.id } })) as OpenCopyLoanRead;
        if (!active || !originatingRef.current.isCurrent('copy.list')) return;
        if (result.page.boundary?.today) {
          setToday(result.page.boundary.today);
          setStartedOn((value) => value || result.page.boundary!.today);
          setReturnedOn(result.page.boundary.today);
        }
        setItem(result.item);
      } catch {
        if (active && originatingRef.current.isCurrent('copy.list')) setFailure(m.library_loans_failure());
      }
    })();
    return () => {
      active = false;
    };
  }, [copy.id]);

  async function send(
    operation: 'copy.create' | 'copy.update',
    run: (headers: HeadersInit) => Promise<LoanWriteResult>,
  ) {
    if (!current(operation) || busy) return;
    const headers = originatingRef.current.headers(operation);
    if (!headers) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await run(headers);
      if (!current(operation)) return;
      if (!result.ok) {
        setFailure(failureText(result.reason));
        return;
      }
      setItem(
        result.loan.returnedOn
          ? null
          : {
              loan: result.loan,
              copy: item?.copy ?? {
                state: 'available',
                id: copy.id,
                revision: copy.revision,
                kind: copy.kind,
                status: copy.status,
                context: { state: 'unavailable' },
              },
            },
      );
      if (result.boundary.today) setToday(result.boundary.today);
    } catch {
      if (current(operation)) setFailure(m.library_loans_failure());
    } finally {
      if (current(operation)) setPending(false);
    }
  }

  async function create() {
    await send('copy.create', async (headers) => {
      const { createLoan } = await import('./loans-actions');
      return createLoan({
        data: {
          copyId: copy.id,
          copyRevision: copy.revision,
          direction,
          counterparty: { kind: 'name', name },
          startedOn,
          ...(dueOn === '' ? {} : { dueOn }),
          idempotencyKey: crypto.randomUUID(),
        },
        headers,
      });
    });
  }

  async function extend() {
    if (!item) return;
    await send('copy.update', async (headers) => {
      const { updateLoanDue } = await import('./loans-actions');
      return updateLoanDue({
        data: {
          loanId: item.loan.id,
          revision: item.loan.revision,
          dueOn: extendDue,
          idempotencyKey: crypto.randomUUID(),
        },
        headers,
      });
    });
  }

  async function complete() {
    if (!item) return;
    await send('copy.update', async (headers) => {
      const { completeLoan } = await import('./loans-actions');
      return completeLoan({
        data: {
          loanId: item.loan.id,
          revision: item.loan.revision,
          returnedOn,
          idempotencyKey: crypto.randomUUID(),
        },
        headers,
      });
    });
  }

  const open = item && !item.loan.returnedOn;
  const loanDirectionOptions = [
    { value: 'lent', label: m.library_loans_lent() },
    { value: 'borrowed', label: m.library_loans_borrowed() },
  ];
  return (
    <section className="min-w-0 space-y-3 rounded-lg border border-border p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="font-medium">{m.library_loans_heading()}</h3>
        <Link to="/library/loans" className="text-sm text-primary underline underline-offset-4">
          {m.library_copy_loans()}
        </Link>
      </header>
      {open ? (
        <div className="space-y-4">
          <p>
            {item.loan.direction === 'lent' ? m.library_loans_lent() : m.library_loans_borrowed()}
            {' · '}
            {counterpartyText(item.loan.counterparty)}
            {item.loan.dueOn ? ` · ${item.loan.dueOn}` : ` · ${m.library_loans_undated()}`}
          </p>
          {item.loan.actions.extend.allowed ? (
            <div className="flex min-w-0 flex-wrap items-end gap-3">
              <div className="min-w-0 flex-1">
                <CalendarDayField
                  id={`${formId}-extend`}
                  label={m.library_loans_due()}
                  value={extendDue}
                  min={item.loan.dueOn ?? item.loan.startedOn}
                  disabled={busy}
                  required
                  onChange={(value) => current() && setExtendDue(value)}
                />
              </div>
              <button
                type="button"
                className={button}
                disabled={busy || !current('copy.update')}
                onClick={() => void extend()}
              >
                {m.library_loans_extend()}
              </button>
            </div>
          ) : null}
          {item.loan.actions.return.allowed ? (
            <div className="flex min-w-0 flex-wrap items-end gap-3">
              <div className="min-w-0 flex-1">
                <CalendarDayField
                  id={`${formId}-return`}
                  label={m.library_loans_returned()}
                  value={returnedOn}
                  min={item.loan.startedOn}
                  max={today}
                  disabled={busy}
                  required
                  onChange={(value) => current() && setReturnedOn(value)}
                />
              </div>
              <button
                type="button"
                className={button}
                disabled={busy || !current('copy.update')}
                onClick={() => void complete()}
              >
                {m.library_loans_return()}
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{m.library_loans_create()}</p>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <Field className="min-w-0 gap-1">
              <FieldLabel id={`${loanDirectionSelectId}-label`} htmlFor={loanDirectionSelectId}>
                {m.library_loans_direction()}
              </FieldLabel>
              <Select<string, false>
                items={loanDirectionOptions}
                disabled={busy}
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
                id={`${formId}-name`}
                className={field}
                value={name}
                maxLength={300}
                disabled={busy}
                onChange={(event) => current() && setName(event.currentTarget.value)}
              />
            </label>
            <CalendarDayField
              id={`${formId}-started`}
              label={m.library_loans_started()}
              value={startedOn}
              disabled={busy}
              required
              onChange={(value) => current() && setStartedOn(value)}
            />
            <CalendarDayField
              id={`${formId}-due`}
              label={m.library_loans_due()}
              value={dueOn}
              min={startedOn}
              disabled={busy}
              onChange={(value) => current() && setDueOn(value)}
            />
          </div>
          <button
            type="button"
            className={button}
            disabled={busy || !current('copy.create')}
            onClick={() => void create()}
          >
            {m.library_loans_submit()}
          </button>
        </div>
      )}
      {failure ? <p role="alert">{failure}</p> : null}
    </section>
  );
}

function counterpartyText(counterparty: OpenItem['loan']['counterparty']): string {
  if (counterparty.kind === 'name') return counterparty.name;
  if (counterparty.state === 'available') return counterparty.displayName;
  return m.library_loans_counterparty_concealed();
}

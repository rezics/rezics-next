import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Loan } from '@rezics/client';
import { m } from '../paraglide/messages.js';
import { CalendarDayField } from './calendar-day-field';
import { LoanCommandIntent, dispatchLoan, type LoanCommand, type LoansOrigin } from './loan-intent';
import { LoanFacts, loanButton, loanQuiet, loanField, loanFailure } from './loan-reading';

export type LoanCopyOperand = { id: string; revision: number };

/** Mounted only for one selected copy/loan, never once per supplied row. */
export function LoanControls({
  loan, copy, today, originating, disabled = false, onRefresh, onLockChange,
}: {
  loan?: Loan;
  copy?: LoanCopyOperand;
  today: string | null;
  originating: LoansOrigin;
  disabled?: boolean;
  onRefresh: () => void;
  onLockChange?: (locked: boolean) => void;
}) {
  const [machine] = useState(() => new LoanCommandIntent(originating, dispatchLoan));
  const state = useSyncExternalStore(machine.subscribe, machine.snapshot, machine.snapshot);
  const current = machine.current();
  const [operation, setOperation] = useState<LoanCommand['operation'] | null>(null);
  const [direction, setDirection] = useState<'lent' | 'borrowed'>('lent');
  const [name, setName] = useState('');
  const [startedOn, setStartedOn] = useState(today ?? '');
  const [dueOn, setDueOn] = useState('');
  const [day, setDay] = useState('');
  const id = useId();
  const formHeading = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const receipt = useRef<HTMLParagraphElement>(null);
  const locked = state.phase === 'pending' || state.phase === 'uncertain';
  useLayoutEffect(() => machine.mount(), [machine]);
  useEffect(() => { if (!current) machine.retire(); }, [current, machine]);
  useLayoutEffect(() => { onLockChange?.(locked); }, [locked, onLockChange]);
  useLayoutEffect(() => { if (operation) formHeading.current?.focus(); else trigger.current?.focus(); }, [operation]);
  useLayoutEffect(() => { if (state.phase === 'saved') receipt.current?.focus(); }, [state.phase]);
  if (!current || state.phase === 'retired') return null;

  const choose = (value: LoanCommand['operation'], button: HTMLButtonElement) => {
    if (disabled || !machine.current()) return;
    trigger.current = button;
    setDay(value === 'return' ? today ?? '' : '');
    setOperation(value);
  };
  const back = () => {
    if (!machine.current()) return;
    if (state.phase === 'refused') machine.correct();
    setOperation(null);
  };
  const label = operation === 'create' ? m.library_loans_create()
    : operation === 'extend' ? m.library_loans_extend() : m.library_loans_return();
  const canEdit = state.phase === 'idle' && !disabled;

  if (state.phase === 'saved') return (
    <div className="min-w-0 space-y-4 rounded-lg border border-border bg-background p-4">
      <p ref={receipt} tabIndex={-1} role="status" className="font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">{m.library_loans_receipt()}</p>
      <LoanFacts loan={state.result.loan} today={state.result.boundary.today} />
      <p className="text-sm text-muted-foreground">{m.library_loans_read_distinct()}</p>
      <button type="button" className={loanQuiet} onClick={() => machine.current() && onRefresh()}>{m.library_loans_refresh()}</button>
    </div>
  );

  return (
    <div className="min-w-0 space-y-4">
      <div hidden={!!operation}>
        <div className="flex flex-wrap gap-3">
          {copy && !loan ? <button type="button" className={loanButton} disabled={disabled || !today || !originating.isCurrent('copy.create')}
            onClick={(event) => choose('create', event.currentTarget)}>{m.library_loans_create()}</button> : null}
          {loan?.actions.extend.allowed ? <button type="button" className={loanQuiet} disabled={disabled || !today || !originating.isCurrent('copy.update')}
            onClick={(event) => choose('extend', event.currentTarget)}>{m.library_loans_extend()}</button> : null}
          {loan?.actions.return.allowed ? <button type="button" className={loanButton} disabled={disabled || !today || !originating.isCurrent('copy.update')}
            onClick={(event) => choose('return', event.currentTarget)}>{m.library_loans_return()}</button> : null}
          {loan && !loan.actions.extend.allowed && !loan.actions.return.allowed ? <p className="text-sm text-muted-foreground">
            {loan.state === 'returned' ? m.library_loans_returned() : m.library_loans_copy_unavailable_action()}
          </p> : null}
        </div>
      </div>
      {operation ? (
        <form className="min-w-0 space-y-4 rounded-lg border border-border bg-background p-4" onSubmit={(event) => {
          event.preventDefault();
          if (!canEdit || !machine.current()) return;
          if (operation === 'create' && copy) void machine.start({ operation, input: {
            copyId: copy.id, copyRevision: copy.revision, direction, counterparty: { kind: 'name', name }, startedOn,
            ...(dueOn === '' ? {} : { dueOn }),
          } });
          else if (operation === 'extend' && loan) void machine.start({ operation, input: { loanId: loan.id, revision: loan.revision, dueOn: day } });
          else if (operation === 'return' && loan) void machine.start({ operation, input: { loanId: loan.id, revision: loan.revision, returnedOn: day } });
        }}>
          <h4 ref={formHeading} tabIndex={-1} className="font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">{label}</h4>
          {operation === 'create' && copy ? (
            <>
              <p className="text-sm [overflow-wrap:anywhere]">{m.library_loans_copy_id()}: <span className="font-mono">{copy.id}</span> · {m.library_loans_copy_revision()}: {copy.revision}</p>
              <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                <label className="min-w-0 space-y-1"><span>{m.library_loans_direction()}</span>
                  <select className={loanField} value={direction} disabled={!canEdit} onChange={(event) => {
                    if (machine.current()) setDirection(event.currentTarget.value as 'lent' | 'borrowed');
                  }}>
                    <option value="lent">{m.library_loans_lent()}</option><option value="borrowed">{m.library_loans_borrowed()}</option>
                  </select>
                </label>
                <label className="min-w-0 space-y-1"><span>{m.library_loans_counterparty()}</span>
                  <input className={loanField} value={name} required disabled={!canEdit}
                    onChange={(event) => machine.current() && setName(event.currentTarget.value)} />
                </label>
                <CalendarDayField id={`${id}-started`} label={m.library_loans_started()} value={startedOn} required disabled={!canEdit}
                  onChange={(value) => machine.current() && setStartedOn(value)} />
                <CalendarDayField id={`${id}-due`} label={m.library_loans_optional_due()} value={dueOn} min={startedOn} disabled={!canEdit}
                  onChange={(value) => machine.current() && setDueOn(value)} />
              </div>
            </>
          ) : loan ? (
            <CalendarDayField id={`${id}-day`} label={operation === 'extend' ? m.library_loans_due() : m.library_loans_returned()}
              value={day} min={operation === 'extend' ? loan.dueOn ?? loan.startedOn : loan.startedOn}
              max={operation === 'return' ? today ?? undefined : undefined} required disabled={!canEdit}
              onChange={(value) => machine.current() && setDay(value)} />
          ) : null}
          {state.phase === 'pending' ? <p role="status">{m.library_loans_pending()}</p> : null}
          {state.phase === 'uncertain' ? <div role="alert" className="space-y-2">
            <p>{m.library_loans_unknown()}</p>
            {state.refusal && state.refusal.reason !== 'unavailable' ? <p>{m.library_loans_unknown_refusal()}</p> : null}
            <button type="button" className={loanButton} disabled={disabled} onClick={() => void machine.retry()}>{m.library_loans_retry_exact()}</button>
          </div> : null}
          {state.phase === 'refused' ? <div role="alert" className="space-y-3">
            <p>{loanFailure(state.result.reason)}</p>
            {state.result.reason === 'invalid' ? <button type="button" className={loanQuiet} onClick={() => machine.correct()}>{m.library_loans_correct()}</button> : null}
            <button type="button" className={loanQuiet} onClick={() => machine.current() && onRefresh()}>{m.library_loans_refresh()}</button>
          </div> : null}
          <div className="flex flex-wrap gap-3">
            {state.phase === 'idle' ? <button type="submit" className={loanButton} disabled={disabled}>{operation === 'create' ? m.library_loans_submit() : label}</button> : null}
            {!locked ? <button type="button" className={loanQuiet} onClick={back}>{m.library_loans_back()}</button> : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}

import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { Exposure } from '../kernel/exposure';
import type { LoansPageData } from './loans-read';
import type { LoansAddress } from './loans-query';
import type { LoansOrigin } from './loan-intent';
import { LoanControls } from './loan-controls';
import { LoanFacts, LoanIdentity, loanButton, loanQuiet, type LoanItem } from './loan-reading';
export type { LoansOrigin } from './loan-intent';

type Selection = { item: LoanItem; expanded: boolean; trigger: HTMLButtonElement };

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
  const [source, setSource] = useState({ page, address, guard: originating.isCurrent });
  const [selected, setSelected] = useState<Selection | null>(null);
  const [locked, setLocked] = useState(false);
  const current = originating.isCurrent();
  if (source.page !== page || source.address !== address || source.guard !== originating.isCurrent) {
    setSource({ page, address, guard: originating.isCurrent });
    setSelected(null);
    setLocked(false);
  }
  if (!current && selected) {
    setSelected(null);
    setLocked(false);
  }
  const select = (item: LoanItem, trigger: HTMLButtonElement) => {
    if (!originating.isCurrent() || (locked && selected?.item !== item)) return;
    setSelected({ item, expanded: true, trigger });
  };
  const close = () => {
    if (!originating.isCurrent() || !selected) return;
    setSelected({ ...selected, expanded: false });
    selected.trigger.focus();
  };
  const lockChanged = useCallback((value: boolean) => setLocked(value), []);
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
  const firstSearch = address.filter === 'history' ? { filter: 'history' as const } : {};
  return (
    <div className="max-w-4xl space-y-6 text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <PageHeading>{m.library_loans_heading()}</PageHeading>
        <Link to="/library/copies" className={loanQuiet}>
          {m.library_loans_copies()}
        </Link>
      </header>
      <Exposure operation="copy.list">
        <nav className="flex flex-wrap gap-3" aria-label={m.library_loans_heading()}>
          <Link
            to="/library/loans"
            search={{}}
            aria-current={address.filter === 'open' ? 'page' : undefined}
            className={address.filter === 'open' ? loanButton : loanQuiet}
            onClick={(event) => {
              if (!originating.isCurrent('copy.list')) event.preventDefault();
            }}
          >
            {m.library_loans_filter_open()}
          </Link>
          <Link
            to="/library/loans"
            search={{ filter: 'history' }}
            aria-current={address.filter === 'history' ? 'page' : undefined}
            className={address.filter === 'history' ? loanButton : loanQuiet}
            onClick={(event) => {
              if (!originating.isCurrent('copy.list')) event.preventDefault();
            }}
          >
            {m.library_loans_filter_history()}
          </Link>
        </nav>
      </Exposure>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium">
          {address.filter === 'history' ? m.library_loans_history() : m.library_loans_open()}
        </h2>
        {address.filter === 'open' ? (
          <Link to="/library/copies" className={loanQuiet}>
            {m.library_loans_create()}
          </Link>
        ) : null}
      </div>
      {address.filter === 'open' ? (
        <p className="text-sm text-muted-foreground">{m.library_loans_select_copy()}</p>
      ) : null}
      {empty ? <p role="status">{empty}</p> : null}
      {page.inventoryState === 'unavailable' ? (
        <button
          type="button"
          className={loanQuiet}
          disabled={!current}
          onClick={() => originating.isCurrent() && onRefresh()}
        >
          {m.library_loans_refresh()}
        </button>
      ) : null}
      {page.items.length ? (
        <ul className="m-0 list-none space-y-4 p-0">
          {page.items.map((item) => (
            <li key={item.loan.id} className="min-w-0 space-y-4 rounded-xl border border-border p-4 sm:p-5">
              <LoanIdentity item={item} />
              <LoanFacts loan={item.loan} today={page.boundary?.today ?? null} />
              <button
                type="button"
                className={loanQuiet}
                aria-expanded={selected?.item === item && selected.expanded}
                disabled={!current || (locked && selected?.item !== item)}
                onClick={(event) => select(item, event.currentTarget)}
              >
                {m.library_loans_inspect()}
              </button>
              {selected?.item === item ? (
                <SelectedLoan
                  item={item}
                  expanded={selected.expanded}
                  onClose={close}
                  originating={originating}
                  today={page.boundary?.today ?? null}
                  onRefresh={onRefresh}
                  onLockChange={lockChanged}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {page.next || address.cursor ? (
        <nav className="flex flex-wrap gap-3" aria-label={m.library_loans_more()}>
          {address.cursor ? (
            <Link
              to="/library/loans"
              search={firstSearch}
              className={loanQuiet}
              onClick={(event) => {
                if (!originating.isCurrent('copy.list')) event.preventDefault();
              }}
            >
              {m.library_collections_first_page()}
            </Link>
          ) : null}
          {page.next ? (
            <Link
              to="/library/loans"
              search={{ ...firstSearch, cursor: page.next }}
              className={loanQuiet}
              onClick={(event) => {
                if (!originating.isCurrent('copy.list')) event.preventDefault();
              }}
            >
              {m.library_loans_more()}
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

function SelectedLoan({
  item,
  expanded,
  onClose,
  originating,
  today,
  onRefresh,
  onLockChange,
}: {
  item: LoanItem;
  expanded: boolean;
  onClose: () => void;
  originating: LoansOrigin;
  today: string | null;
  onRefresh: () => void;
  onLockChange: (locked: boolean) => void;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    if (expanded) heading.current?.focus();
  }, [expanded]);
  return (
    <section hidden={!expanded} aria-labelledby={id} className="min-w-0 space-y-4 border-t border-border pt-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h3
          id={id}
          ref={heading}
          tabIndex={-1}
          className="font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {m.library_loans_inspect()}
        </h3>
        <button type="button" className={loanQuiet} onClick={onClose}>
          {m.library_loans_close()}
        </button>
      </header>
      <LoanControls
        loan={item.loan}
        today={today}
        originating={originating}
        onRefresh={onRefresh}
        onLockChange={onLockChange}
      />
    </section>
  );
}

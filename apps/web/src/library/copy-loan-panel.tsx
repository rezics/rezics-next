import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import type { CopyItem } from './copies-read';
import type { OpenCopyLoanRead } from './loans-actions';
import type { LoansOrigin } from './loan-intent';
import { LoanControls } from './loan-controls';
import { LoanFacts, loanQuiet } from './loan-reading';

export function CopyLoanPanel(props: { copy: CopyItem; originating: LoansOrigin; disabled: boolean }) {
  const [scope, setScope] = useState({ guard: props.originating.isCurrent, generation: 0 });
  if (scope.guard !== props.originating.isCurrent)
    setScope({ guard: props.originating.isCurrent, generation: scope.generation + 1 });
  // A new exact copy revision or accepted source retires the old controls together.
  return <CopyLoanVisit key={`${props.copy.id}:${props.copy.revision}:${scope.generation}`} {...props} />;
}

function CopyLoanVisit({
  copy,
  originating,
  disabled,
}: {
  copy: CopyItem;
  originating: LoansOrigin;
  disabled: boolean;
}) {
  const [read, setRead] = useState<OpenCopyLoanRead | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [readVersion, setReadVersion] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [retired, setRetired] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const focusAfterExpansion = useRef<'heading' | 'trigger' | null>(null);
  const refreshFocus = useRef<{ trigger: HTMLButtonElement; moved: boolean } | null>(null);
  const id = useId();
  const [source] = useState(originating);
  const current = !retired && source.isCurrent('copy.list');
  useLayoutEffect(() => {
    const destination = focusAfterExpansion.current;
    focusAfterExpansion.current = null;
    if (!current) return;
    if (destination === 'heading' && expanded) heading.current?.focus();
    if (destination === 'trigger' && !expanded) trigger.current?.focus();
  }, [current, expanded]);
  useEffect(() => {
    if (!current) setRetired(true);
  }, [current]);
  useEffect(() => {
    let active = true;
    if (!source.isCurrent('copy.list')) return;
    void (async () => {
      let result: OpenCopyLoanRead;
      try {
        const { readOpenCopyLoan } = await import('./loans-actions');
        result = await readOpenCopyLoan({ data: { copyId: copy.id } });
      } catch {
        if (active && source.isCurrent('copy.list')) {
          setFailed(true);
          setRefreshing(false);
        }
        return;
      }
      if (!active || !source.isCurrent('copy.list')) return;
      setRead(result);
      setFailed(false);
      setRefreshing(false);
      if (generation > 0) setReadVersion((value) => value + 1);
    })();
    return () => {
      active = false;
    };
  }, [copy.id, generation, source]);
  useEffect(() => {
    const trackFocus = (event: FocusEvent) => {
      const pending = refreshFocus.current;
      if (!pending || event.target === document.body || event.target === document.documentElement) return;
      if (event.target !== pending.trigger) pending.moved = true;
    };
    document.addEventListener('focusin', trackFocus);
    return () => document.removeEventListener('focusin', trackFocus);
  }, []);
  const unavailable =
    read && (!read.page.signedIn || read.copyId !== copy.id || read.page.inventoryState || !read.page.boundary);
  useLayoutEffect(() => {
    const pending = refreshFocus.current;
    if (!pending || refreshing) return;
    refreshFocus.current = null;
    if (pending.moved || !source.isCurrent('copy.list')) return;
    (failed || unavailable ? retry.current : trigger.current)?.focus();
  }, [failed, read, refreshing, source, unavailable]);
  const refresh = (button: HTMLButtonElement) => {
    if (!source.isCurrent('copy.list')) return;
    refreshFocus.current = { trigger: button, moved: false };
    setFailed(false);
    setRefreshing(true);
    setGeneration((value) => value + 1);
  };
  const inspect = () => {
    if (!source.isCurrent() || expanded) return;
    focusAfterExpansion.current = 'heading';
    setExpanded(true);
  };
  const close = () => {
    if (!source.isCurrent() || !expanded) return;
    focusAfterExpansion.current = 'trigger';
    setExpanded(false);
  };
  if (!current) return null;
  return (
    <section className="min-w-0 space-y-4 rounded-lg border border-border p-4" aria-labelledby={`${id}-title`}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h3 id={`${id}-title`} className="font-medium">
          {m.library_loans_heading()}
        </h3>
        <Link to="/library/loans" className={loanQuiet}>
          {m.library_copy_loans()}
        </Link>
      </header>
      {failed || unavailable ? (
        <div className="space-y-3">
          <p role="status">
            {read?.page.inventoryState === 'forbidden' ? m.library_loans_forbidden() : m.library_loans_unavailable()}
          </p>
          <button
            ref={retry}
            type="button"
            className={loanQuiet}
            disabled={disabled}
            onClick={(event) => refresh(event.currentTarget)}
          >
            {m.library_loans_refresh()}
          </button>
        </div>
      ) : null}
      {refreshing || (!read && !failed) ? <p role="status">{m.library_sort_preparing()}</p> : null}
      {read && !unavailable ? (
        <>
          {read.item ? (
            <LoanFacts loan={read.item.loan} today={read.page.boundary?.today ?? null} />
          ) : (
            <p className="text-sm text-muted-foreground">{m.library_loans_create_copy()}</p>
          )}
          <button
            ref={trigger}
            type="button"
            className={loanQuiet}
            aria-expanded={expanded}
            aria-controls={`${id}-controls`}
            disabled={disabled}
            onClick={inspect}
          >
            {m.library_loans_inspect()}
          </button>
          <section
            id={`${id}-controls`}
            hidden={!expanded}
            aria-labelledby={`${id}-selected`}
            className="space-y-4 border-t border-border pt-4"
          >
            <header className="flex flex-wrap items-center justify-between gap-3">
              <h4
                id={`${id}-selected`}
                ref={heading}
                tabIndex={-1}
                className="font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {m.library_loans_inspect()}
              </h4>
              <button type="button" className={loanQuiet} onClick={close}>
                {m.library_loans_close()}
              </button>
            </header>
            <LoanControls
              loan={read.item?.loan}
              copy={read.item ? undefined : { id: copy.id, revision: copy.revision }}
              today={read.page.boundary?.today ?? null}
              originating={source}
              disabled={disabled}
              onRefresh={refresh}
              readVersion={readVersion}
            />
          </section>
        </>
      ) : null}
    </section>
  );
}

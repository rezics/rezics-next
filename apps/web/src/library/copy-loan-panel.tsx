import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import type { CopyItem } from './copies-read';
import type { OpenCopyLoanRead } from './loans-actions';
import type { LoansOrigin } from './loan-intent';
import { Button } from '@rezics/ui/shadcn/button';
import { LoanControls } from './loan-controls';
import { LoanFacts } from './loan-reading';

const controlWrap = 'h-auto min-h-7 max-w-full whitespace-normal [overflow-wrap:anywhere]';
const compactWrap = 'h-auto min-h-6 max-w-full whitespace-normal [overflow-wrap:anywhere]';

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
  const [searching, setSearching] = useState(true);
  const [request, setRequest] = useState<{ cursor: string | null; sequence: number }>({ cursor: null, sequence: 0 });
  const sequence = useRef(0);
  const [readVersion, setReadVersion] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [retired, setRetired] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const more = useRef<HTMLButtonElement>(null);
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
        result = await readOpenCopyLoan({
          data: { copyId: copy.id, ...(request.cursor !== null ? { cursor: request.cursor } : {}) },
        });
      } catch {
        if (active && sequence.current === request.sequence && source.isCurrent('copy.list')) {
          setFailed(true);
          setSearching(false);
        }
        return;
      }
      if (!active || sequence.current !== request.sequence || !source.isCurrent('copy.list')) return;
      setRead(result);
      setFailed(false);
      setSearching(false);
      if (request.sequence > 0) setReadVersion((value) => value + 1);
    })();
    return () => {
      active = false;
    };
  }, [copy.id, request, source]);
  useEffect(() => {
    const trackFocus = (event: FocusEvent) => {
      const pending = refreshFocus.current;
      if (!pending || event.target === document.body || event.target === document.documentElement) return;
      if (event.target !== pending.trigger) pending.moved = true;
    };
    document.addEventListener('focusin', trackFocus);
    return () => document.removeEventListener('focusin', trackFocus);
  }, []);
  const pageCursor = read ? (read.page.requestedCursor ?? null) : null;
  const readCursor = read ? (read.requestedCursor === undefined ? pageCursor : read.requestedCursor) : null;
  const unavailable =
    !!read &&
    (!read.page.signedIn ||
      read.copyId !== copy.id ||
      (!searching && (readCursor !== request.cursor || pageCursor !== request.cursor)) ||
      !!read.page.inventoryState ||
      !read.page.boundary ||
      read.outcome === null);
  useLayoutEffect(() => {
    const pending = refreshFocus.current;
    if (!pending || searching) return;
    refreshFocus.current = null;
    if (pending.moved || !source.isCurrent('copy.list')) return;
    (failed || unavailable ? retry.current : (trigger.current ?? more.current))?.focus();
  }, [failed, read, searching, source, unavailable]);
  const startSearch = (cursor: string | null, button?: HTMLButtonElement) => {
    if (!source.isCurrent('copy.list')) return;
    refreshFocus.current = button ? { trigger: button, moved: false } : null;
    const nextSequence = sequence.current + 1;
    sequence.current = nextSequence;
    setFailed(false);
    setSearching(true);
    setRequest({ cursor, sequence: nextSequence });
  };
  const refresh = (button: HTMLButtonElement) => {
    startSearch(null, button);
  };
  const retryPage = (button: HTMLButtonElement) => {
    startSearch(request.cursor, button);
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
  const outcome = read?.outcome;
  const found = outcome?.kind === 'found' ? outcome.item : outcome === undefined && read?.item ? read.item : null;
  const exhausted = outcome?.kind === 'exhausted' || (outcome === undefined && !!read && !read.item);
  const continuation = outcome?.kind === 'continuation' ? outcome.cursor : null;
  const controlsDisabled = disabled || searching || failed;
  return (
    <section className="min-w-0 space-y-4 rounded-lg border border-border p-4" aria-labelledby={`${id}-title`}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h3 id={`${id}-title`} className="font-medium">
          {m.library_loans_heading()}
        </h3>
        <Button
          variant="outline"
          size="sm"
          className={compactWrap}
          nativeButton={false}
          render={<Link to="/library/loans" />}
        >
          {m.library_copy_loans()}
        </Button>
      </header>
      {failed || unavailable ? (
        <div className="space-y-3">
          <p role="status">
            {read?.page.inventoryState === 'forbidden' ? m.library_loans_forbidden() : m.library_loans_unavailable()}
          </p>
          <Button
            ref={retry}
            type="button"
            variant="outline"
            className={controlWrap}
            disabled={disabled || searching}
            onClick={(event) => retryPage(event.currentTarget)}
          >
            {m.library_loans_refresh()}
          </Button>
          {request.cursor !== null ? (
            <Button
              type="button"
              variant="outline"
              className={controlWrap}
              disabled={disabled || searching}
              onClick={(event) => refresh(event.currentTarget)}
            >
              {m.library_collections_first_page()}
            </Button>
          ) : null}
        </div>
      ) : null}
      {searching ? <p role="status">{m.candidate_loading()}</p> : null}
      {read && !unavailable ? (
        <>
          {found ? (
            <LoanFacts loan={found.loan} today={read.page.boundary?.today ?? null} />
          ) : exhausted ? (
            <p className="text-sm text-muted-foreground">{m.library_loans_create_copy()}</p>
          ) : (
            <Button
              ref={more}
              type="button"
              variant="outline"
              className={controlWrap}
              disabled={controlsDisabled || continuation === null}
              onClick={(event) => continuation !== null && startSearch(continuation, event.currentTarget)}
            >
              {m.library_loans_more()}
            </Button>
          )}
          {found || exhausted ? (
            <>
              <Button
                ref={trigger}
                type="button"
                variant="outline"
                className={controlWrap}
                aria-expanded={expanded}
                aria-controls={`${id}-controls`}
                disabled={controlsDisabled}
                onClick={inspect}
              >
                {m.library_loans_inspect()}
              </Button>
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
                  <Button type="button" variant="outline" size="sm" className={compactWrap} onClick={close}>
                    {m.library_loans_close()}
                  </Button>
                </header>
                <LoanControls
                  {...(found ? { loan: found.loan } : {})}
                  {...(exhausted ? { copy: { id: copy.id, revision: copy.revision } } : {})}
                  today={read.page.boundary?.today ?? null}
                  originating={source}
                  disabled={controlsDisabled}
                  onRefresh={refresh}
                  readVersion={readVersion}
                />
              </section>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

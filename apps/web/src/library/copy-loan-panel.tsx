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

function CopyLoanVisit({ copy, originating, disabled }: { copy: CopyItem; originating: LoansOrigin; disabled: boolean }) {
  const [read, setRead] = useState<OpenCopyLoanRead | null>(null);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [retired, setRetired] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const [source] = useState(originating);
  const current = !retired && source.isCurrent('copy.list');
  useEffect(() => { if (!current) setRetired(true); }, [current]);
  useLayoutEffect(() => { if (expanded) heading.current?.focus(); else trigger.current?.focus(); }, [expanded]);
  useEffect(() => {
    let active = true;
    if (!source.isCurrent('copy.list')) return;
    void (async () => {
      let result: OpenCopyLoanRead;
      try {
        const { readOpenCopyLoan } = await import('./loans-actions');
        result = await readOpenCopyLoan({ data: { copyId: copy.id } });
      } catch {
        if (active && source.isCurrent('copy.list')) setFailed(true);
        return;
      }
      if (!active || !source.isCurrent('copy.list')) return;
      setRead(result);
    })();
    return () => { active = false; };
  }, [copy.id, generation, source]);
  const refresh = () => {
    if (!source.isCurrent('copy.list')) return;
    setRead(null);
    setFailed(false);
    setGeneration((value) => value + 1);
  };
  if (!current) return null;
  const unavailable = read && (!read.page.signedIn || read.copyId !== copy.id || read.page.inventoryState || !read.page.boundary);
  return (
    <section className="min-w-0 space-y-4 rounded-lg border border-border p-4" aria-labelledby={`${id}-title`}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h3 id={`${id}-title`} className="font-medium">{m.library_loans_heading()}</h3>
        <Link to="/library/loans" className={loanQuiet}>{m.library_copy_loans()}</Link>
      </header>
      {failed || unavailable ? <div className="space-y-3">
        <p role="status">{read?.page.inventoryState === 'forbidden' ? m.library_loans_forbidden() : m.library_loans_unavailable()}</p>
        <button type="button" className={loanQuiet} disabled={disabled} onClick={refresh}>{m.library_loans_refresh()}</button>
      </div> : !read ? <p role="status">{m.library_sort_preparing()}</p> : (
        <>
          {read.item ? <LoanFacts loan={read.item.loan} today={read.page.boundary?.today ?? null} /> : <p className="text-sm text-muted-foreground">{m.library_loans_create_copy()}</p>}
          <button ref={trigger} type="button" className={loanQuiet} aria-expanded={expanded} aria-controls={`${id}-controls`}
            disabled={disabled} onClick={() => source.isCurrent() && setExpanded(true)}>{m.library_loans_inspect()}</button>
          <section id={`${id}-controls`} hidden={!expanded} aria-labelledby={`${id}-selected`} className="space-y-4 border-t border-border pt-4">
            <header className="flex flex-wrap items-center justify-between gap-3">
              <h4 id={`${id}-selected`} ref={heading} tabIndex={-1} className="font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">{m.library_loans_inspect()}</h4>
              <button type="button" className={loanQuiet} onClick={() => source.isCurrent() && setExpanded(false)}>{m.library_loans_close()}</button>
            </header>
            <LoanControls key={generation} loan={read.item?.loan} copy={read.item ? undefined : { id: copy.id, revision: copy.revision }}
              today={read.page.boundary?.today ?? null} originating={source} disabled={disabled} onRefresh={refresh} />
          </section>
        </>
      )}
    </section>
  );
}

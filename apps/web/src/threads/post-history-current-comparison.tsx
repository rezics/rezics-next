import { useContext, useLayoutEffect, useRef, useState } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { ExactRevisionView } from './exact-revision-view';
import { readExactRevision } from './exact-revision-read';
import { readExactRevisionVisit, type ExactRevisionVisit } from './exact-revision-caller';
import { historicalBindingCurrent, historicalReaderSource } from './historical-reader-provenance';
import type { ExactRevisionState } from './exact-revision';
import type { HistoryComparison } from './post-history-context';

/** Read only the admitted immutable comparison address; no current-head or command read is added. */
export function HistoryComparisonReader({
  comparison,
  isCurrent,
}: {
  comparison: HistoryComparison;
  isCurrent: () => boolean;
}) {
  const client = useContext(QueryClientContext);
  const locale = getLocale();
  const [open, setOpen] = useState(false);
  const [visit, setVisit] = useState<ExactRevisionVisit>();
  const [fallback, setFallback] = useState<ExactRevisionState>({ state: 'loading' });
  const trigger = useRef<HTMLButtonElement>(null);
  const target = useRef<HTMLElement>(null);
  const generation = useRef(0);
  const live = useRef(false);
  const pending = useRef(false);
  const identity = { postId: comparison.postId, revisionId: comparison.toRevisionId };
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      generation.current++;
    };
  }, []);
  useLayoutEffect(() => {
    if (open && isCurrent()) target.current?.focus({ preventScroll: true });
  }, [open]);
  async function read() {
    if (!client || pending.current || !live.current || !isCurrent()) return;
    const ticket = ++generation.current;
    pending.current = true;
    setVisit(undefined);
    setFallback({ state: 'loading' });
    setOpen(true);
    const source = historicalReaderSource(client);
    const credentialMode = source.read().credentialMode;
    try {
      const result = await readExactRevisionVisit(client, identity, locale, credentialMode, (binding) =>
        readExactRevision({ data: { ...identity, locale, credentialMode, binding } }),
      );
      if (!live.current || !isCurrent() || ticket !== generation.current) return;
      if (historicalBindingCurrent(source, result.admission.binding, result.provenance.actualReader)) setVisit(result);
      else setFallback(result.page.state === 'problem' ? result.page : { state: 'unavailable', status: 404 });
    } catch {
      if (live.current && isCurrent() && ticket === generation.current)
        setFallback({ state: 'problem', status: 503, code: null });
    } finally {
      if (ticket === generation.current) pending.current = false;
    }
  }
  function close() {
    if (!live.current || !isCurrent()) return;
    generation.current++;
    pending.current = false;
    setOpen(false);
    setVisit(undefined);
    trigger.current?.focus({ preventScroll: true });
  }
  const admitted =
    visit &&
    client &&
    historicalBindingCurrent(historicalReaderSource(client), visit.admission.binding, visit.provenance.actualReader);
  return (
    <div className="min-w-0 space-y-3" data-history-comparison="">
      <Button ref={trigger} type="button" variant="outline" onClick={() => void read()} disabled={!client || open}>
        {m.post_history_compare()}
      </Button>
      {open && isCurrent() ? (
        <section
          ref={target}
          tabIndex={-1}
          aria-label={m.post_history_compare()}
          className="space-y-3 rounded-lg border p-3"
        >
          <p>
            {m.post_history_comparison_from()}: <span dir="ltr">{comparison.fromRevisionId}</span>
          </p>
          <p>
            {m.post_history_comparison_to()}: <span dir="ltr">{comparison.toRevisionId}</span>
          </p>
          <Button type="button" variant="outline" onClick={close}>
            {m.post_history_comparison_close()}
          </Button>
          <ExactRevisionView
            identity={identity}
            page={admitted ? visit.page : fallback}
            isReadingCurrent={isCurrent}
            readingIdentity={comparison}
            onRetry={() => void read()}
          />
        </section>
      ) : null}
    </div>
  );
}

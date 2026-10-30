import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { ArrowLeft, CheckCircle2, Clock3, LoaderCircle, ShieldAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { threadLocation } from './thread-href';
import { authorErasureRefreshes, erasureRefreshLimit, erasureStage, type ErasureRead } from './author-erasure';
import { erasureRefusal } from './author-erasure-entry';

function terminalError(code: number): string {
  if (code === 7 || code === 16) return m.author_erasure_terminal_permission();
  if (code === 9 || code === 10) return m.author_erasure_terminal_changed();
  if (code === 14 || code === 4 || code === 8) return m.author_erasure_terminal_dependency();
  return m.author_erasure_terminal_failed();
}

/** The authenticated route supplies only one current native operation. No workflow restoration runs here. */
export function AuthorErasureOperationPage({
  initial,
  read,
}: {
  initial: ErasureRead;
  read: () => Promise<ErasureRead>;
}) {
  const [state, setState] = useState(initial);
  const [pending, setPending] = useState(false);
  const [remaining, setRemaining] = useState(erasureRefreshLimit);
  const [automatic, setAutomatic] = useState(true);
  const reader = useRef(read);
  reader.current = read;
  const budget = useRef<ReturnType<typeof authorErasureRefreshes> | null>(null);
  budget.current ??= authorErasureRefreshes(() => reader.current());
  const busy = useRef(false);
  const alive = useRef(true);
  const available = state.kind === 'available';
  const operation = available ? state.operation : null;
  const stage = operation ? erasureStage(operation) : null;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function refresh(foreground: boolean) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    let next: ErasureRead | null;
    try {
      next = foreground
        ? await budget.current!.foreground(document.visibilityState === 'visible')
        : await reader.current();
    } catch {
      next = { kind: 'unavailable' };
    }
    busy.current = false;
    if (!alive.current) return;
    setPending(false);
    setRemaining(budget.current!.remaining());
    if (next) {
      setState(next);
      if (next.kind !== 'available') setAutomatic(false);
    }
  }

  useEffect(() => {
    if (!operation || operation.done || !automatic || remaining === 0 || pending) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (document.visibilityState === 'visible') timer = setTimeout(() => void refresh(true), 2000);
    };
    schedule();
    document.addEventListener('visibilitychange', schedule);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [operation, automatic, remaining, pending]);

  const title =
    stage === 'completed'
      ? m.author_erasure_completed()
      : stage === 'failed'
        ? m.author_erasure_failed()
        : stage === 'running'
          ? m.author_erasure_running()
          : stage === 'queued'
            ? m.author_erasure_queued()
            : m.author_erasure_status_unavailable();
  const Icon =
    stage === 'completed'
      ? CheckCircle2
      : stage === 'failed' || !operation
        ? ShieldAlert
        : stage === 'running'
          ? LoaderCircle
          : Clock3;
  const counters = operation?.done && operation.response ? operation.response : operation?.metadata;
  const manual = !automatic || remaining === 0 || !operation;
  return (
    <article className="mx-auto w-full min-w-0 max-w-3xl space-y-6" data-slot="author-erasure-operation">
      <header className="space-y-2">
        <p className="text-sm font-medium text-muted-foreground">{m.author_erasure_operation_label()}</p>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{m.author_erasure_operation_title()}</h1>
        <p className="max-w-prose text-muted-foreground">{m.author_erasure_scope()}</p>
      </header>
      <section
        className="space-y-5 rounded-xl border border-border bg-card p-5 sm:p-7"
        aria-labelledby="erasure-status"
      >
        <div className="flex items-center gap-3" role="status" aria-live="polite">
          <Icon aria-hidden="true" className="size-6 shrink-0 text-muted-foreground" />
          <h2 id="erasure-status" className="text-xl font-semibold">
            {title}
          </h2>
        </div>
        {!available ? (
          <p role="alert" className="leading-relaxed">
            {erasureRefusal(state.kind)}
          </p>
        ) : null}
        {operation ? (
          <p className="max-w-prose leading-relaxed text-muted-foreground">
            {operation.done
              ? operation.error
                ? terminalError(operation.error.code)
                : m.author_erasure_success()
              : stage === 'running'
                ? m.author_erasure_running_copy()
                : m.author_erasure_queued_copy()}
          </p>
        ) : null}
        {counters && operation ? (
          <dl className="grid grid-cols-1 gap-5 border-y border-border py-5 sm:grid-cols-3">
            {[
              [m.author_erasure_processed(), counters.processedPosts],
              [m.author_erasure_revisions(), counters.erasedRevisions],
              [m.author_erasure_steps(), operation.metadata.steps],
            ].map(([label, value]) => (
              <div key={label} className="space-y-1">
                <dt className="text-sm text-muted-foreground">{label}</dt>
                <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {operation && !operation.done ? (
          <p className="text-sm leading-relaxed text-muted-foreground">
            {manual ? m.author_erasure_manual() : m.author_erasure_bounded_refresh()}
          </p>
        ) : null}
        {manual && !operation?.done ? (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => {
              setAutomatic(false);
              void refresh(false);
            }}
          >
            {pending ? m.author_erasure_checking() : m.author_erasure_check_again()}
          </Button>
        ) : null}
        {operation ? (
          <a
            className={buttonVariants({ variant: 'ghost' })}
            href={threadLocation(getLocale(), { id: operation.metadata.threadId, title: null })}
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            {m.author_erasure_back_thread()}
          </a>
        ) : null}
      </section>
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{m.author_erasure_irreversible()}</p>
    </article>
  );
}

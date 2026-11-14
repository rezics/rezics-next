import { useEffect, useId, useRef, type MouseEvent, type Ref } from 'react';
import { Bookmark, ChevronDown } from 'lucide-react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';

export type HostedBookCheckpointControlsProps = {
  locale: Locale;
  chapter: boolean;
  controlsRef?: Ref<HTMLElement>;
  message: string | null;
  saved: boolean;
  withheld: boolean;
  resume: { href: string; title: string } | null;
  busy: boolean;
  blocked: boolean;
  isCurrent: () => boolean;
  originalAction?: string | null;
  observed?: string | null;
  save?: () => void;
  clear?: () => void;
  /** Retry only the failed body-free checkpoint observation. */
  retry?: () => void;
  replay?: { kind: 'save' | 'clear'; run: () => void };
  recoverCurrent?: () => void;
};

const control = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal text-start [overflow-wrap:anywhere]';

/** Shared 44px controls; recovery announces a result without taking focus from another task. */
export function HostedBookCheckpointControls({
  locale,
  chapter,
  controlsRef,
  message,
  saved,
  withheld,
  resume,
  busy,
  blocked,
  isCurrent,
  originalAction,
  observed,
  save,
  clear,
  retry,
  replay,
  recoverCurrent,
}: HostedBookCheckpointControlsProps) {
  const options = { locale };
  const resultId = useId();
  const status = useRef<HTMLDivElement>(null);
  const focus = useRef<HTMLButtonElement | null>(null);
  const activate = (run: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
    if (!isCurrent()) return;
    // Pointer activation leaves focus alone. Keyboard activation owns only its original control.
    focus.current =
      event.detail === 0 && event.currentTarget.ownerDocument.activeElement === event.currentTarget
        ? event.currentTarget
        : null;
    run();
  };
  useEffect(() => {
    const document = status.current!.ownerDocument;
    const cancel = (event: Event) => {
      if (focus.current && event.target !== focus.current) focus.current = null;
    };
    document.addEventListener('focusin', cancel);
    document.addEventListener('pointerdown', cancel, true);
    return () => {
      document.removeEventListener('focusin', cancel);
      document.removeEventListener('pointerdown', cancel, true);
    };
  }, []);
  useEffect(() => {
    if (busy || !focus.current) return;
    const origin = focus.current;
    focus.current = null;
    const document = origin.ownerDocument;
    if (
      isCurrent() &&
      (document.activeElement === origin || (!origin.isConnected && document.activeElement === document.body))
    ) {
      status.current?.focus({ preventScroll: true });
    }
  }, [busy, message, originalAction, observed]);

  return (
    <section
      ref={controlsRef}
      aria-label={m.book_reader_checkpoint_title({}, options)}
      className={`${chapter ? 'sticky top-0 z-20' : ''} min-w-0 border-y bg-background/95 px-1 py-2`}
    >
      <h2 className="sr-only">{m.book_reader_checkpoint_title({}, options)}</h2>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1" aria-busy={busy}>
        {resume ? (
          <a
            href={resume.href}
            className={buttonVariants({ variant: chapter ? 'ghost' : 'outline', className: control })}
            onClick={(event) => {
              if (!isCurrent()) event.preventDefault();
            }}
          >
            {m.book_reader_checkpoint_resume({}, options)}
          </a>
        ) : null}
        {save ? (
          <Button variant="outline" className={`${control} gap-2`} disabled={blocked} onClick={activate(save)}>
            <Bookmark aria-hidden="true" className="size-4 shrink-0" />
            {m.book_reader_checkpoint_save({}, options)}
          </Button>
        ) : null}
        {saved ? (
          <details className="group min-w-0 max-w-full text-sm">
            <summary
              className={`inline-flex cursor-pointer list-none items-center gap-2 rounded-md px-2 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden ${control}`}
            >
              {m.book_reader_checkpoint_details({}, options)}
              <ChevronDown aria-hidden="true" className="size-4 shrink-0 group-open:rotate-180" />
            </summary>
            <div className="grid min-w-0 justify-items-start gap-2 border-s ps-3 pb-2 [overflow-wrap:anywhere]">
              {resume ? (
                <p className="max-w-prose leading-relaxed">
                  <bdi>{resume.title}</bdi>
                </p>
              ) : null}
              {clear ? (
                <>
                  <Button
                    variant="ghost"
                    className={`${control} text-muted-foreground`}
                    disabled={blocked}
                    onClick={activate(clear)}
                  >
                    {m.book_reader_checkpoint_clear({}, options)}
                  </Button>
                  <p className="max-w-prose text-muted-foreground leading-relaxed">
                    {m.book_reader_checkpoint_clear_scope({}, options)}
                  </p>
                </>
              ) : null}
            </div>
          </details>
        ) : null}
        {replay ? (
          <Button
            variant="outline"
            className={control}
            disabled={busy}
            aria-describedby={resultId}
            onClick={activate(replay.run)}
          >
            {replay.kind === 'save'
              ? m.book_reader_checkpoint_retry_save({}, options)
              : m.book_reader_checkpoint_retry_clear({}, options)}
          </Button>
        ) : null}
        {retry ? (
          <Button variant="outline" className={control} disabled={busy} onClick={activate(retry)}>
            {m.book_reader_checkpoint_retry_read({}, options)}
          </Button>
        ) : null}
        {recoverCurrent ? (
          <Button variant="outline" className={control} disabled={busy} onClick={activate(recoverCurrent)}>
            {m.book_reader_checkpoint_recover_current({}, options)}
          </Button>
        ) : null}
      </div>
      <div
        ref={status}
        id={resultId}
        role="status"
        aria-atomic="true"
        tabIndex={-1}
        className="max-w-prose rounded-md px-2 text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {message ? <p className="py-1">{message}</p> : null}
        {originalAction ? (
          <p className="py-1">
            <bdi>{originalAction}</bdi>
          </p>
        ) : null}
        {observed ? (
          <p className="py-1">
            <bdi>{observed}</bdi>
          </p>
        ) : null}
        {withheld ? <p className="py-1">{m.book_reader_checkpoint_withheld({}, options)}</p> : null}
      </div>
    </section>
  );
}

import type { Ref } from 'react';
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
  save?: () => void;
  clear?: () => void;
  retry?: () => void;
};

const control = 'min-h-11 min-w-11 max-w-full whitespace-normal text-start [overflow-wrap:anywhere]';

/** Shared presentation for native checkpoints and explicitly illustrative review stories. */
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
  save,
  clear,
  retry,
}: HostedBookCheckpointControlsProps) {
  const options = { locale };
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
          <Button variant="outline" className={`${control} gap-2`} disabled={blocked} onClick={save}>
            <Bookmark aria-hidden="true" className="size-4 shrink-0" />
            {m.book_reader_checkpoint_save({}, options)}
          </Button>
        ) : null}
        {saved ? (
          <details className="group min-w-0 max-w-full text-sm">
            <summary
              className={`inline-flex min-h-11 max-w-full cursor-pointer list-none items-center gap-2 rounded-md px-2 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden ${control}`}
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
              {withheld ? (
                <p className="max-w-prose leading-relaxed text-muted-foreground">
                  {m.book_reader_checkpoint_withheld({}, options)}
                </p>
              ) : null}
              {clear ? (
                <Button
                  variant="ghost"
                  className={`${control} text-muted-foreground`}
                  disabled={blocked}
                  onClick={clear}
                >
                  {m.book_reader_checkpoint_clear({}, options)}
                </Button>
              ) : null}
            </div>
          </details>
        ) : null}
        {retry ? (
          <Button variant="outline" className={control} disabled={busy} onClick={retry}>
            {m.book_reader_retry({}, options)}
          </Button>
        ) : null}
      </div>
      {message ? (
        <p role="status" className="max-w-prose px-2 py-1 text-sm leading-relaxed text-muted-foreground">
          {message}
        </p>
      ) : null}
    </section>
  );
}

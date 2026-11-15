import { useCallback, useRef, useState } from 'react';
import { cn } from '@rezics/ui/utils';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../../../paraglide/messages.js';
import { subjectHref, subjectUrlForView } from '../../../../subject/load-subject';
import { contextHref } from '../../../pages/context-navigation';
import { useReaderFocus } from './focus';
import { action, linkClass } from './controls';

type Address = { id: string; locale: string; realm?: string | undefined };

/** An opaque route address supplies safe navigation, never a retained title or edit authority. */
export function SafeNavigation({ id, locale, realm }: Address) {
  const o = { locale: locale as never };
  const base = subjectHref({ id, label: '' }, locale);
  const nav = useRef<HTMLElement>(null);
  const active = useCallback(() => true, []);
  const heading = useCallback(() => {
    nav.current?.closest('[data-slot="game-reader"]')?.querySelector<HTMLHeadingElement>('h2')?.focus();
  }, []);
  const focus = useReaderFocus(active, heading);
  return (
    <nav ref={nav} aria-label={m.game_reader_fallback({}, o)} className="flex flex-wrap gap-x-4">
      <a
        onClick={focus.navigate}
        className={linkClass}
        href={contextHref(base.href, realm)}
        target="_blank"
        rel="noopener"
      >
        {m.game_reader_current_subject({}, o)}
      </a>
      <a
        onClick={focus.navigate}
        className={linkClass}
        href={contextHref(subjectUrlForView(base, 'details'), realm)}
        target="_blank"
        rel="noopener"
      >
        {m.game_reader_fallback({}, o)}
      </a>
    </nav>
  );
}

/** Recovery asks the installed route loader for a fresh source; the retired lease stays retired. */
export function RetiredReading(props: Address & { refresh?: (() => Promise<void>) | undefined }) {
  const o = { locale: props.locale as never };
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const flight = useRef(false);
  return (
    <section
      aria-label={m.game_reader_retired({}, o)}
      className="min-w-0 space-y-3 rounded-lg border border-border bg-muted/20 p-4"
      aria-busy={busy}
    >
      <p role="status">{m.game_reader_retired({}, o)}</p>
      <p className="text-sm text-muted-foreground">{m.game_reader_return({}, o)}</p>
      {props.refresh ? (
        <button
          type="button"
          className={cn(buttonVariants({ variant: 'outline' }), action)}
          disabled={busy}
          onClick={async () => {
            if (flight.current) return;
            flight.current = true;
            setBusy(true);
            setFailed(false);
            try {
              await props.refresh!();
            } catch {
              setFailed(true);
            } finally {
              flight.current = false;
              setBusy(false);
            }
          }}
        >
          {m.game_reader_recover({}, o)}
        </button>
      ) : null}
      {failed ? <p role="alert">{m.game_reader_recovery_failed({}, o)}</p> : null}
      <SafeNavigation {...props} />
    </section>
  );
}

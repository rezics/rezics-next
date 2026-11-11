import { useCallback, useMemo } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { NativeHostedBookReader } from './native-hosted-book-reader';
import { hostedBookAddressHref } from './address';
import type { NativeHostedBookAdmissionSource } from './native-source';
import type { BookReaderNavigation } from './reader-state';
import type { HostedBookReaderProps } from './hosted-book-reader';
import type { HostedBookVisit } from './visit';

export { readHostedBookVisit } from './native-visit';
export { parseHostedBookSearch, hostedBookHref, hostedBookAddressHref, hostedBookSearch } from './address';
export { HostedBookReaderLink } from './link';
export type { HostedBookSearch } from './address';
export type { HostedBookVisit } from './visit';

export type HostedBookVisitViewProps = {
  visit: HostedBookVisit;
  locale: Locale;
  navigate: (href: string) => void;
  reload: () => void;
  /** Supplied only when the existing Commerce owner has admitted an occurrence-aware region. */
  renderProgress?: HostedBookReaderProps['renderProgress'];
};

/** One production visit, using the retained native source and document reader. No body cache in the router. */
export function HostedBookVisitView({ visit, locale, navigate, reload, renderProgress }: HostedBookVisitViewProps) {
  const admission = useMemo<NativeHostedBookAdmissionSource>(
    () => ({
      getSnapshot: () => (visit.state === 'ready' ? visit.admission : { state: 'unavailable' }),
      subscribe: () => () => {},
    }),
    [visit],
  );
  const open = useCallback<BookReaderNavigation>(
    (address, contentsReturn) => {
      const href = hostedBookAddressHref(address, locale, contentsReturn);
      navigate(href);
    },
    [locale, navigate],
  );
  const focusOnRead = useMemo<HostedBookReaderProps['focusOnRead']>(() => {
    if (visit.state !== 'ready' || typeof document === 'undefined') return undefined;
    const owner = document.activeElement;
    // A shared header/search control chosen during navigation keeps its focus.
    if (owner && owner !== document.body && !owner.closest('[data-slot="hosted-book-reader"]')) return undefined;
    return {
      owner,
      focus:
        visit.address.kind === 'contents' && visit.address.selection
          ? { kind: 'occurrence', occurrenceId: visit.address.selection.occurrenceId }
          : { kind: 'heading' },
    };
  }, [visit]);
  const options = { locale };
  if (visit.state !== 'ready')
    return (
      <section className="mx-auto grid max-w-3xl gap-4 px-4 py-8" lang={locale} data-slot="hosted-book-visit">
        <h1 className="text-2xl font-semibold">{m.book_reader_title({}, options)}</h1>
        <p role="status">
          {visit.state === 'denied'
            ? m.book_reader_denied({}, options)
            : visit.state === 'not-found'
              ? m.book_reader_not_found({}, options)
              : visit.state === 'changed'
                ? m.book_reader_changed({}, options)
                : m.book_reader_unavailable({}, options)}
        </p>
        <Button className="min-h-11 min-w-11 justify-self-start" variant="outline" onClick={reload}>
          {m.book_reader_retry({}, options)}
        </Button>
      </section>
    );
  const origin = visit.address.kind === 'contents' ? visit.address : visit.contentsReturn;
  return (
    <NativeHostedBookReader
      address={visit.address}
      contentsReturn={visit.contentsReturn}
      admission={admission}
      locale={locale}
      hrefForAddress={(address) => hostedBookAddressHref(address, locale, origin)}
      onNavigate={open}
      onReload={reload}
      focusOnRead={focusOnRead}
      renderProgress={renderProgress}
    />
  );
}

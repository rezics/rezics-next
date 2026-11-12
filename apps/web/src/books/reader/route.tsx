import { useCallback, useMemo } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { NativeHostedBookReader } from './native-hosted-book-reader';
import { hostedBookAddressHref, hostedBookHref, hostedBookSubjectHref } from './address';
import { HostedBookCheckpoint } from './checkpoint';
import type { NativeHostedBookAdmissionSource } from './native-source';
import type { BookPage } from './source';
import type { BookReaderNavigation } from './reader-state';
import type { HostedBookReaderProps } from './hosted-book-reader';
import type { HostedBookVisit } from './visit';

export { readHostedBookVisit } from './native-visit';
export {
  parseHostedBookSearch,
  hostedBookHref,
  hostedBookAddressHref,
  hostedBookSearch,
  hostedBookSubjectHref,
} from './address';
export { HostedBookReaderLink, HostedBookSubjectReaderLink } from './link';
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
      const href = hostedBookAddressHref(
        address,
        locale,
        contentsReturn,
        visit.state === 'ready' ? visit.subjectId : undefined,
      );
      navigate(href);
    },
    [locale, navigate, visit],
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
  if (visit.state === 'catalogues')
    return (
      <section className="mx-auto grid max-w-3xl gap-4 px-4 py-8" lang={locale}>
        <h1 className="text-2xl font-semibold">{m.book_reader_title({}, options)}</h1>
        {visit.page.items.length === 0 ? <p role="status">{m.book_reader_catalogues_empty({}, options)}</p> : null}
        <ol className="grid gap-3">
          {visit.page.items.map((item, index) => (
            <li key={item.catalogueId}>
              <a
                className="inline-flex min-h-11 items-center underline underline-offset-4"
                href={hostedBookHref(item.catalogueId, locale, {
                  subject: visit.page.subjectId,
                  release: item.revisionId,
                })}
              >
                {m.book_reader_publication({ number: index + 1 }, options)}
              </a>
            </li>
          ))}
        </ol>
        {visit.page.nextCursor ? (
          <a
            className="inline-flex min-h-11 items-center underline underline-offset-4"
            href={hostedBookSubjectHref(visit.page.subjectId, locale, visit.page.nextCursor)}
          >
            {m.book_reader_more({}, options)}
          </a>
        ) : null}
      </section>
    );
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
  const subjectId = visit.subjectId;
  const viewer = visit.admission.viewer;
  return (
    <NativeHostedBookReader
      address={visit.address}
      contentsReturn={visit.contentsReturn}
      admission={admission}
      locale={locale}
      hrefForAddress={(address) => hostedBookAddressHref(address, locale, origin, visit.subjectId)}
      onNavigate={open}
      onReload={reload}
      {...(focusOnRead !== undefined ? { focusOnRead } : {})}
      {...(renderProgress !== undefined ? { renderProgress } : {})}
      {...(subjectId && viewer.kind === 'session'
        ? {
            renderCheckpoint: (page: BookPage, isCurrent: () => boolean) => (
              <HostedBookCheckpoint
                subjectId={subjectId}
                viewer={viewer.subject}
                page={page}
                locale={locale}
                isCurrent={isCurrent}
                reload={reload}
              />
            ),
          }
        : {})}
    />
  );
}

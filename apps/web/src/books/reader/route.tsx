import { useCallback, useContext, useMemo } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { readerSessionSource } from '../../reader/lifetime';
import { createBookContentsNavigation } from './contents-navigation';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { NativeHostedBookReader } from './native-hosted-book-reader';
import { hostedBookAddressHref, hostedBookHref, hostedBookSubjectHref } from './address';
import { HostedBookCheckpoint } from './checkpoint';
import type { NativeHostedBookAdmissionSource } from './native-source';
import type { BookPage } from './source';
import type { CheckpointPosition } from './checkpoint-position';
import type { BookReaderFocus, BookReaderNavigation } from './reader-state';
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

/** Route-owned memory survives loader replacement, but never survives leaving this publication visit. */
export function createHostedBookNavigation() {
  const contents = createBookContentsNavigation();
  let scope: string | null = null;
  let pendingFocus: HostedBookReaderProps['focusOnRead'];
  let stopFocus: (() => void) | undefined;
  const cancelFocus = () => {
    pendingFocus = undefined;
    stopFocus?.();
    stopFocus = undefined;
  };
  return {
    contents,
    bind(identity: string) {
      if (scope !== null && scope !== identity) {
        contents.retire();
        cancelFocus();
      }
      scope = identity;
    },
    retire() {
      contents.retire();
      scope = null;
      cancelFocus();
    },
    captureFocus(focus: BookReaderFocus) {
      cancelFocus();
      if (!focus || typeof document === 'undefined') return;
      const owner = document.activeElement;
      pendingFocus = { owner, focus };
      const moved = (event: FocusEvent) => {
        if (event.target !== owner) cancelFocus();
      };
      document.addEventListener('focusin', moved);
      document.addEventListener('pointerdown', cancelFocus, true);
      stopFocus = () => {
        document.removeEventListener('focusin', moved);
        document.removeEventListener('pointerdown', cancelFocus, true);
      };
    },
    focusOnRead: () => pendingFocus,
    cancelFocus,
  };
}
export type HostedBookNavigation = ReturnType<typeof createHostedBookNavigation>;

export type HostedBookVisitViewProps = {
  visit: HostedBookVisit;
  locale: Locale;
  navigate: (href: string) => void;
  reload: () => void;
  navigation?: HostedBookNavigation;
  /** Supplied only when the existing Commerce owner has admitted an occurrence-aware region. */
  renderProgress?: HostedBookReaderProps['renderProgress'];
};

/** One production visit, using the retained native source and document reader. No body cache in the router. */
export function HostedBookVisitView({ visit, locale, navigate, reload, navigation, renderProgress }: HostedBookVisitViewProps) {
  const localNavigation = useMemo(createHostedBookNavigation, []);
  const coordinates = navigation ?? localNavigation;
  const client = useContext(QueryClientContext);
  const session = readerSessionSource(client);
  if (visit.state === 'ready') {
    const { publication, viewer, currentReleaseRevisionId, currentStructureRevisionId } = visit.admission;
    coordinates.bind(JSON.stringify([
      publication, currentReleaseRevisionId, currentStructureRevisionId, locale,
      viewer.kind, viewer.kind === 'session' ? viewer.subject : null, session.snapshot(),
    ]));
  }
  const admission = useMemo<NativeHostedBookAdmissionSource>(
    () => ({
      getSnapshot: () => (visit.state === 'ready' ? visit.admission : { state: 'unavailable' }),
      subscribe: () => () => {},
    }),
    [visit],
  );
  const open = useCallback<BookReaderNavigation>(
    (address, contentsReturn, focus) => {
      coordinates.captureFocus(focus);
      const href = hostedBookAddressHref(
        address,
        locale,
        contentsReturn,
        visit.state === 'ready' ? visit.subjectId : undefined,
      );
      navigate(href);
    },
    [locale, navigate, visit, coordinates],
  );
  const focusOnRead = coordinates.focusOnRead();
  const reread = (focus: BookReaderFocus = null) => {
    coordinates.captureFocus(focus);
    reload();
  };
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
                {item.title || m.book_reader_publication({ number: index + 1 }, options)}
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
      onReload={reread}
      contentsNavigation={coordinates.contents}
      {...(focusOnRead !== undefined ? { focusOnRead } : {})}
      {...(renderProgress !== undefined ? { renderProgress } : {})}
      {...(subjectId && viewer.kind === 'session'
        ? {
            renderCheckpoint: (page: BookPage, isCurrent: () => boolean, position: CheckpointPosition) => (
              <HostedBookCheckpoint
                subjectId={subjectId}
                viewer={viewer.subject}
                page={page}
                position={position}
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

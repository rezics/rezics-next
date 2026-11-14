import { useCallback, useContext, useMemo } from 'react';
import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import type { AnyRouter } from '@tanstack/react-router';
import { readerSessionSource } from '../../reader/lifetime';
import { createBookContentsNavigation } from './contents-navigation';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { NativeHostedBookReader } from './native-hosted-book-reader';
import { hostedBookAddressHref, hostedBookHref, hostedBookSubjectHref, type HostedBookSearch } from './address';
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
        if (event.target !== owner && !(event.target === document.body && !owner?.isConnected)) cancelFocus();
      };
      document.addEventListener('focusin', moved);
      document.addEventListener('pointerdown', cancelFocus, true);
      window.addEventListener('blur', cancelFocus);
      stopFocus = () => {
        document.removeEventListener('focusin', moved);
        document.removeEventListener('pointerdown', cancelFocus, true);
        window.removeEventListener('blur', cancelFocus);
      };
    },
    focusOnRead: () => pendingFocus,
    cancelFocus,
  };
}
export type HostedBookNavigation = ReturnType<typeof createHostedBookNavigation>;

// One bounded visit per live Router survives loader/pending remounts. It is never history payload.
const contentsVisits = new WeakMap<AnyRouter, HostedBookNavigation>();

/** Bind the route's contents and focus memory to its existing Router and credential lifetime. */
export function hostedBookNavigationForRouter(
  router: AnyRouter,
  client: QueryClient | undefined,
): HostedBookNavigation {
  const existing = contentsVisits.get(router);
  if (existing) return existing;

  const navigation = createHostedBookNavigation();
  contentsVisits.set(router, navigation);
  const path = router.state.location.pathname;
  const stopSession = readerSessionSource(client).subscribe(() => navigation.retire());
  if (typeof window !== 'undefined') window.addEventListener('pagehide', navigation.retire);
  const stopRoute = router.subscribe('onBeforeLoad', ({ toLocation }) => {
    if (toLocation.pathname === path) return;
    navigation.retire();
    contentsVisits.delete(router);
    stopSession();
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', navigation.retire);
    stopRoute();
  });
  return navigation;
}

export type HostedBookVisitViewProps = {
  visit: HostedBookVisit;
  locale: Locale;
  navigate: (href: string) => void;
  reload: () => void;
  navigation?: HostedBookNavigation;
  location?: { catalogueId: string; search: HostedBookSearch };
  /** Supplied only when the existing Commerce owner has admitted an occurrence-aware region. */
  renderProgress?: HostedBookReaderProps['renderProgress'];
};

/** One production visit, using the retained native source and document reader. No body cache in the router. */
export function HostedBookVisitView({
  visit,
  locale,
  navigate,
  reload,
  navigation,
  location,
  renderProgress,
}: HostedBookVisitViewProps) {
  const localNavigation = useMemo(createHostedBookNavigation, []);
  const coordinates = navigation ?? localNavigation;
  const client = useContext(QueryClientContext);
  const session = readerSessionSource(client);
  if (visit.state === 'ready') {
    const { publication, viewer, currentReleaseRevisionId, currentStructureRevisionId } = visit.admission;
    coordinates.bind(
      JSON.stringify([
        publication.id,
        publication.structureRevisionId,
        publication.releaseRevisionId,
        currentReleaseRevisionId,
        currentStructureRevisionId,
        locale,
        viewer.kind,
        viewer.kind === 'session' ? viewer.subject : null,
        session.snapshot(),
      ]),
    );
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
  if (visit.state !== 'ready') {
    const search = location?.search;
    const contents = !!location && (search?.view === 'contents' || (search?.view === undefined && !search?.occurrence));
    const first =
      location && contents
        ? hostedBookHref(location.catalogueId, locale, {
            release: search?.release,
            occurrence: search?.occurrence,
            subject: search?.subject,
            view: 'contents',
            parent: search?.parent,
          })
        : null;
    const chapter =
      location && contents && search?.occurrence
        ? hostedBookHref(location.catalogueId, locale, {
            release: search.release,
            occurrence: search.occurrence,
            subject: search.subject,
            view: 'chapter',
            returnParent: search.parent,
            returnCursor: search.cursor,
          })
        : null;
    const linkClass =
      'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal underline underline-offset-4 [overflow-wrap:anywhere]';
    return (
      <section className="mx-auto grid max-w-3xl gap-4 px-4 py-8" lang={locale} data-slot="hosted-book-visit">
        <h1 className="text-2xl font-semibold">
          {contents ? m.book_reader_contents({}, options) : m.book_reader_title({}, options)}
        </h1>
        {contents ? (
          <p className="text-sm text-muted-foreground">{m.book_reader_contents_recovery({}, options)}</p>
        ) : null}
        <p role="status">
          {visit.state === 'denied'
            ? m.book_reader_denied({}, options)
            : visit.state === 'not-found'
              ? m.book_reader_not_found({}, options)
              : visit.state === 'changed'
                ? m.book_reader_changed({}, options)
                : m.book_reader_unavailable({}, options)}
        </p>
        <div className="flex min-w-0 flex-wrap gap-2">
          <Button
            className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal text-start [overflow-wrap:anywhere]"
            variant="outline"
            onClick={(event) => reread(event.detail === 0 ? { kind: 'heading' } : null)}
          >
            {m.book_reader_retry({}, options)}
          </Button>
          {first ? (
            <a
              className={linkClass}
              href={first}
              onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
                event.preventDefault();
                coordinates.captureFocus(event.detail === 0 ? { kind: 'heading' } : null);
                coordinates.contents.stage({ parentOccurrenceId: search?.parent ?? null, cursor: null }, 'first');
                navigate(first);
              }}
            >
              {m.book_reader_first_page({}, options)}
            </a>
          ) : null}
          {chapter ? (
            <a
              className={linkClass}
              href={chapter}
              onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
                event.preventDefault();
                coordinates.captureFocus(event.detail === 0 ? { kind: 'heading' } : null);
                navigate(chapter);
              }}
            >
              {m.book_reader_return_chapter({}, options)}
            </a>
          ) : null}
        </div>
      </section>
    );
  }
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

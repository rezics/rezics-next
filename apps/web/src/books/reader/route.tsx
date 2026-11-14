import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, type MouseEvent } from 'react';
import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import type { AnyRouter } from '@tanstack/react-router';
import { readerSessionSource } from '../../reader/lifetime';
import { createBookContentsNavigation } from './contents-navigation';
import { bookCatalogueReturn, createBookCatalogueNavigation, withBookCatalogueReturn } from './catalogue-navigation';
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

/** Route-owned public outline rows and coordinates survive chapter movement; bodies never enter this visit. */
export function createHostedBookNavigation() {
  const contents = createBookContentsNavigation();
  const catalogues = createBookCatalogueNavigation();
  let scope: string | null = null;
  let pendingFocus: HostedBookReaderProps['focusOnRead'];
  let pendingChooserOpen = false;
  let catalogueFocus: { owner: Element | null; catalogueId: string | null } | undefined;
  let stopFocus: (() => void) | undefined;
  const cancelFocus = () => {
    pendingFocus = undefined;
    pendingChooserOpen = false;
    catalogueFocus = undefined;
    stopFocus?.();
    stopFocus = undefined;
  };
  const watchFocus = (owner: Element | null) => {
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
  };
  return {
    contents,
    catalogues,
    bind(identity: string) {
      if (scope !== null && scope !== identity) {
        contents.retire();
        cancelFocus();
      }
      scope = identity;
    },
    retireReading() {
      contents.retire();
      scope = null;
      if (pendingFocus && !pendingChooserOpen) cancelFocus();
      pendingChooserOpen = false;
    },
    retire() {
      contents.retire();
      catalogues.retire();
      scope = null;
      cancelFocus();
    },
    captureFocus(focus: BookReaderFocus, fromChooser = false) {
      cancelFocus();
      if (!focus || typeof document === 'undefined') return;
      pendingChooserOpen = fromChooser;
      const owner = document.activeElement;
      pendingFocus = { owner, focus };
      watchFocus(owner);
    },
    captureCatalogueFocus(catalogueId: string | null, keyboard: boolean) {
      cancelFocus();
      if (!keyboard || typeof document === 'undefined') return;
      const owner = document.activeElement;
      catalogueFocus = { owner, catalogueId };
      watchFocus(owner);
    },
    focusOnRead: () => pendingFocus,
    catalogueFocusOnRead: () => catalogueFocus,
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
  let path = router.state.location.pathname;
  const stopSession = readerSessionSource(client).subscribe(() => navigation.retire());
  if (typeof window !== 'undefined') window.addEventListener('pagehide', navigation.retire);
  const stopRoute = router.subscribe('onBeforeLoad', ({ toLocation }) => {
    if (toLocation.pathname === path) return;
    if (/\/books\/[^/]+\/read\/?$/.test(toLocation.pathname)) {
      // Publication changes retire chapter/TOC memory; the independent chooser return stays in this Router.
      navigation.retireReading();
      path = toLocation.pathname;
      return;
    }
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
  } else coordinates.retireReading();
  const chooser =
    visit.state === 'catalogues'
      ? { subjectId: visit.page.subjectId, cursor: location?.search.cursor ?? null }
      : location?.search.view === 'catalogues'
        ? { subjectId: location.catalogueId, cursor: location.search.cursor ?? null }
        : null;
  const catalogueReturn = chooser ? null : bookCatalogueReturn(location?.search ?? {});
  const catalogueScope = chooser ?? catalogueReturn;
  if (catalogueScope) {
    if (coordinates.catalogues.bind(JSON.stringify([catalogueScope.subjectId, locale, session.snapshot()]))) {
      coordinates.cancelFocus();
    }
    if (visit.state === 'catalogues') coordinates.catalogues.observe(chooser!.cursor);
  } else coordinates.catalogues.retire();
  const catalogueHeading = useRef<HTMLHeadingElement>(null);
  const catalogueRegion = useRef<HTMLElement>(null);
  const catalogueFocus = coordinates.catalogueFocusOnRead();
  const catalogueGeneration = coordinates.catalogues.generation();
  useLayoutEffect(() => {
    if (!chooser || !catalogueFocus) return;
    const frame = requestAnimationFrame(() => {
      if (
        coordinates.catalogues.generation() !== catalogueGeneration ||
        coordinates.catalogueFocusOnRead() !== catalogueFocus
      )
        return;
      const active = document.activeElement;
      if (active !== catalogueFocus.owner && !(active === document.body && !catalogueFocus.owner?.isConnected)) return;
      const row = [
        ...(catalogueRegion.current?.querySelectorAll<HTMLAnchorElement>('[data-book-catalogue]') ?? []),
      ].find((element) => element.dataset.bookCatalogue === catalogueFocus.catalogueId);
      coordinates.cancelFocus();
      (row ?? catalogueHeading.current)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [visit, locale, coordinates, catalogueFocus, catalogueGeneration, chooser?.subjectId, chooser?.cursor]);
  useEffect(
    () => () => {
      if (!navigation) coordinates.retire();
    },
    [coordinates, navigation],
  );
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
      const href = withBookCatalogueReturn(
        hostedBookAddressHref(address, locale, contentsReturn, visit.state === 'ready' ? visit.subjectId : undefined),
        catalogueReturn,
      );
      navigate(href);
    },
    [locale, navigate, visit, coordinates, catalogueReturn],
  );
  const focusOnRead = coordinates.focusOnRead();
  const reread = (focus: BookReaderFocus = null) => {
    coordinates.captureFocus(focus);
    reload();
  };
  const options = { locale };
  const linkClass =
    'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal rounded-sm underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring [overflow-wrap:anywhere]';
  const ordinaryActivation = (event: MouseEvent<HTMLAnchorElement>) =>
    event.button === 0 && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
  const failure =
    visit.state === 'denied'
      ? m.book_reader_denied({}, options)
      : visit.state === 'not-found'
        ? m.book_reader_not_found({}, options)
        : visit.state === 'changed'
          ? m.book_reader_changed({}, options)
          : m.book_reader_unavailable({}, options);
  if (chooser) {
    const page = visit.state === 'catalogues' ? visit.page : null;
    const previous = coordinates.catalogues.previous(chooser.cursor);
    const href = (cursor: string | null) => hostedBookSubjectHref(chooser.subjectId, locale, cursor ?? undefined);
    const traverse = (
      event: MouseEvent<HTMLAnchorElement>,
      cursor: string | null,
      movement: 'next' | 'exact' | 'first',
    ) => {
      if (!ordinaryActivation(event)) return;
      event.preventDefault();
      coordinates.captureCatalogueFocus(null, event.detail === 0);
      coordinates.catalogues.stage(cursor, movement);
      if (cursor === chooser.cursor) reload();
      else navigate(href(cursor));
    };
    return (
      <section
        ref={catalogueRegion}
        className="mx-auto grid min-w-0 max-w-3xl gap-4 px-4 py-8"
        lang={locale}
        data-slot="hosted-book-catalogues"
      >
        <h1 ref={catalogueHeading} tabIndex={-1} className="text-2xl font-semibold [overflow-wrap:anywhere]">
          {m.book_reader_catalogues_heading({}, options)}
        </h1>
        {page ? (
          <>
            {page.items.length === 0 ? <p role="status">{m.book_reader_catalogues_empty({}, options)}</p> : null}
            <ol className="grid min-w-0 gap-3">
              {page.items.map((item, index) => {
                const target = withBookCatalogueReturn(
                  hostedBookHref(item.catalogueId, locale, {
                    subject: page.subjectId,
                    release: item.revisionId,
                  }),
                  chooser,
                );
                return (
                  <li key={item.catalogueId} className="min-w-0">
                    <a
                      className={linkClass}
                      data-book-catalogue={item.catalogueId}
                      href={target}
                      onClick={(event) => {
                        if (!ordinaryActivation(event)) return;
                        event.preventDefault();
                        coordinates.captureFocus(event.detail === 0 ? { kind: 'heading' } : null, true);
                        navigate(target);
                      }}
                    >
                      {item.title || m.book_reader_publication({ number: index + 1 }, options)}
                    </a>
                  </li>
                );
              })}
            </ol>
          </>
        ) : (
          <>
            <p role="status">{failure}</p>
            <p className="text-sm text-muted-foreground">{m.book_reader_catalogues_recovery({}, options)}</p>
          </>
        )}
        <nav aria-label={m.book_reader_catalogues_heading({}, options)} className="flex min-w-0 flex-wrap gap-3">
          {!page ? (
            <Button
              variant="outline"
              className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal text-start [overflow-wrap:anywhere]"
              onClick={(event) => {
                coordinates.captureCatalogueFocus(null, event.detail === 0);
                reload();
              }}
            >
              {m.book_reader_retry({}, options)}
            </Button>
          ) : null}
          {previous ? (
            <a
              className={linkClass}
              href={href(previous.cursor)}
              onClick={(event) => traverse(event, previous.cursor, 'exact')}
            >
              {m.book_reader_catalogues_previous({}, options)}
            </a>
          ) : null}
          {chooser.cursor !== null || !page ? (
            <a className={linkClass} href={href(null)} onClick={(event) => traverse(event, null, 'first')}>
              {m.book_reader_catalogues_first({}, options)}
            </a>
          ) : null}
          {page?.nextCursor ? (
            <a
              className={linkClass}
              href={href(page.nextCursor)}
              onClick={(event) => traverse(event, page.nextCursor, 'next')}
            >
              {m.book_reader_catalogues_more({}, options)}
            </a>
          ) : null}
        </nav>
      </section>
    );
  }
  const catalogueReturnLink = catalogueReturn ? (
    <a
      className={linkClass}
      href={hostedBookSubjectHref(catalogueReturn.subjectId, locale, catalogueReturn.cursor ?? undefined)}
      onClick={(event) => {
        if (!ordinaryActivation(event)) return;
        event.preventDefault();
        coordinates.captureCatalogueFocus(location?.catalogueId ?? null, event.detail === 0);
        navigate(hostedBookSubjectHref(catalogueReturn.subjectId, locale, catalogueReturn.cursor ?? undefined));
      }}
    >
      {m.book_reader_catalogues_return({}, options)}
    </a>
  ) : null;
  if (visit.state !== 'ready') {
    const search = location?.search;
    const contents = !!location && (search?.view === 'contents' || (search?.view === undefined && !search?.occurrence));
    const first =
      location && contents
        ? withBookCatalogueReturn(
            hostedBookHref(location.catalogueId, locale, {
              release: search?.release,
              occurrence: search?.occurrence,
              subject: search?.subject,
              view: 'contents',
              parent: search?.parent,
            }),
            catalogueReturn,
          )
        : null;
    const chapter =
      location && contents && search?.occurrence
        ? withBookCatalogueReturn(
            hostedBookHref(location.catalogueId, locale, {
              release: search.release,
              occurrence: search.occurrence,
              subject: search.subject,
              view: 'chapter',
              returnParent: search.parent,
              returnCursor: search.cursor,
            }),
            catalogueReturn,
          )
        : null;
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
          {catalogueReturnLink}
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
    <div className="min-w-0">
      {catalogueReturnLink ? (
        <nav
          className="mx-auto flex max-w-[52rem] flex-wrap gap-2 px-4 pt-4 sm:px-8"
          aria-label={m.book_reader_catalogues_heading({}, options)}
        >
          {catalogueReturnLink}
        </nav>
      ) : null}
      <NativeHostedBookReader
        address={visit.address}
        contentsReturn={visit.contentsReturn}
        admission={admission}
        locale={locale}
        hrefForAddress={(address, contentsReturn) =>
          withBookCatalogueReturn(
            hostedBookAddressHref(address, locale, contentsReturn ?? origin, visit.subjectId),
            catalogueReturn,
          )
        }
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
    </div>
  );
}

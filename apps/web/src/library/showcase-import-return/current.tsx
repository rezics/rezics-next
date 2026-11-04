import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useLibraryWorkspaceAdmission } from '../library-workspace-admission';
import type { VndbVisit } from '../personal-list-import/visit';
import { getLocale } from '../../paraglide/runtime.js';
import { useFollowingReturn } from '../following-reading/return';
import type { ShelfLayout, ShelfSize } from '../shelf-params';
import type { ImportLibraryRead } from './read';
import { readImportLibrary } from './server';
import { ImportLibraryView } from './view';
import { createImportLibraryBrowser, type ImportLibraryBrowser } from './browser';
import { importLibraryAnchor } from './navigation';

type Reader = (visit: VndbVisit, cursor?: string) => Promise<ImportLibraryRead>;
export const ImportLibraryReaderContext = createContext<Reader | null>(null);
const operations = ['library_entry.list'] as const;

/** One source/results episode and one native page. Neither the import coordinator nor its receipts are readers. */
export function CurrentImportLibrary({ visit, returned = false }: { visit: VndbVisit; returned?: boolean }) {
  const supplied = useContext(ImportLibraryReaderContext);
  const { store, value } = useLibraryWorkspaceAdmission(operations);
  const admitted = value.allowed[0];
  const version = value.dispatch[0];
  const locale = getLocale();
  const router = useRouter({ warn: false });
  const owner = useRef<{
    visit: VndbVisit;
    version: number | undefined;
    locale: string;
    supplied: Reader | null;
    browser: ImportLibraryBrowser;
  } | null>(null);
  if (
    !owner.current ||
    owner.current.visit !== visit ||
    owner.current.version !== version ||
    owner.current.locale !== locale ||
    owner.current.supplied !== supplied
  ) {
    owner.current?.browser.retire();
    const subject = visit.subject;
    const credential = visit.csrfToken;
    const browser = createImportLibraryBrowser({
      current: () =>
        visit.current() &&
        visit.subject === subject &&
        visit.csrfToken === credential &&
        getLocale() === locale &&
        store.allowed('library_entry.list') &&
        store.dispatchVersion('library_entry.list') === version,
      read: (cursor) =>
        supplied
          ? supplied(visit, cursor)
          : readImportLibrary({
              data: {
                expectedReader: subject,
                expectedCredential: credential,
                ...(cursor === undefined ? {} : { cursor }),
              },
            }),
    });
    owner.current = { visit, version, locale, supplied, browser };
  }
  const browser = owner.current.browser;
  const snapshot = useSyncExternalStore(browser.subscribe, browser.snapshot, browser.snapshot);
  const [layout, setLayout] = useState<ShelfLayout>('list');
  const [size, setSize] = useState<ShelfSize>('m');
  const heading = useRef<HTMLHeadingElement>(null);
  const focus = useRef<{ browser: ImportLibraryBrowser; element: Element | null } | null>(null);

  useEffect(() => {
    const stop = store.watch(() => browser.current());
    return () => {
      stop();
      browser.retire();
    };
  }, [browser, store]);

  useEffect(() => {
    const ticket = focus.current;
    if (!ticket || ticket.browser !== browser || snapshot.pending) return;
    focus.current = null;
    if (
      browser.current() &&
      snapshot.visible &&
      !snapshot.failed &&
      (document.activeElement === ticket.element ||
        (!ticket.element?.isConnected && document.activeElement === document.body))
    ) {
      heading.current?.focus({ preventScroll: true });
    }
  }, [browser, snapshot]);

  useFollowingReturn(browser.current, browser.suspend, () => {
    if (browser.current()) void browser.refresh();
  });

  function run(action: () => Promise<unknown>) {
    if (!browser.current() || snapshot.pending) return;
    focus.current = { browser, element: document.activeElement };
    void action();
  }

  function depart(event: MouseEvent<HTMLAnchorElement>) {
    if (!browser.current()) {
      event.preventDefault();
      return;
    }
    // Back returns to this landmark. It carries no native inventory cursor into public work navigation.
    if (router && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      const location = router.state.location;
      router.history.replace(`${location.href.split('#')[0]}#${importLibraryAnchor}`, location.state);
    }
    browser.suspend();
    focus.current = null;
  }

  const current = !!admitted && visit.current() && !snapshot.retired;
  return (
    <ImportLibraryView
      {...(current ? { snapshot } : {})}
      result={null}
      busy={current && !!snapshot.pending}
      available={current}
      returned={returned}
      headingRef={heading}
      layout={layout}
      size={size}
      onLayout={(next) => browser.current() && setLayout(next)}
      onSize={(next) => browser.current() && setSize(next)}
      onRead={() => run(browser.first)}
      onNext={() => run(browser.next)}
      onPrevious={() => run(browser.previous)}
      onRetry={() => run(browser.retry)}
      onRestart={() => run(browser.restart)}
      onRefresh={() => run(browser.refresh)}
      onDepart={depart}
    />
  );
}

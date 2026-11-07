import { useCallback, useRef, useState, type RefObject } from 'react';
import { realmReadingReturn, realmReadingSelection } from './realm-reading-return';
import {
  isRealmMembershipCompletion,
  isRealmPublicationCompletion,
  type RealmCompletion,
} from './realm-community/completion';
import type { SpacePageData } from './space';
import type { SpacePageLifetime } from './space-page-lifetime';

/** Only admitted shelf reads can advance this visit's public return address. */
export function useSpaceReadingReturn(page: SpacePageData, href: string, locale: string) {
  const localizedHref = /^\/(en|zh-Hant|zh-Hans|ja|ko|fr|de|es)\//.test(href) ? href : `/${locale}${href}`;
  const initialReturn =
    realmReadingReturn(localizedHref, locale) ??
    (page.realm ? `/${locale}/realms/${page.realm.id}` : localizedHref.split(/[?#]/, 1)[0]!);
  const [readingReturn, setReadingReturn] = useState(initialReturn);
  const readingReturnRef = useRef(readingReturn);
  readingReturnRef.current = readingReturn;
  const updateReadingReturn = useCallback((href: string) => {
    if (href === readingReturnRef.current) return;
    const current = realmReadingSelection(readingReturnRef.current);
    const next = realmReadingSelection(href);
    const regionId =
      current.node === 'boards'
        ? 'realm-boards-heading'
        : current.node === 'publications'
          ? 'realm-published-heading'
          : undefined;
    if (
      regionId &&
      current.node === next.node &&
      current.cursor === next.cursor &&
      current.focus &&
      current.focus !== regionId &&
      next.focus === regionId
    )
      return;
    readingReturnRef.current = href;
    setReadingReturn(href);
  }, []);
  return { localizedHref, initialReturn, readingReturn, readingReturnRef, updateReadingReturn, setReadingReturn };
}

/** The supplying shelf receives focus only after acknowledgement, admitted refresh and committed render. */
export function useSupplyingShelfCompletion({
  page,
  lifetime,
  locale,
  initialReturn,
  readingReturnRef,
  pageRoot,
  realmRemoved,
  orphaned,
  frozen,
  readable,
}: {
  page: SpacePageData;
  lifetime: SpacePageLifetime | null;
  locale: string;
  initialReturn: string;
  readingReturnRef: RefObject<string>;
  pageRoot: RefObject<HTMLElement | null>;
  realmRemoved: boolean;
  orphaned: boolean | undefined;
  frozen: boolean | undefined;
  readable: boolean;
}) {
  const onRealmCompleted = useCallback(
    (receipt: RealmCompletion) => {
      const realm = page.realm;
      const sourceHref = realmReadingReturn(readingReturnRef.current, locale);
      const routeHref = realmReadingReturn(initialReturn, locale);
      if (
        (!isRealmMembershipCompletion(receipt) && !isRealmPublicationCompletion(receipt)) ||
        !realm ||
        !lifetime ||
        receipt.realmId !== realm.id ||
        !receipt.current() ||
        !receipt.focusEligible() ||
        !lifetime.current() ||
        !lifetime.matchesPage(page) ||
        realmRemoved ||
        orphaned ||
        frozen ||
        !readable ||
        !sourceHref ||
        !routeHref ||
        sourceHref.split(/[?#]/u, 1)[0] !== routeHref.split(/[?#]/u, 1)[0]
      )
        return false;

      const selection = realmReadingSelection(sourceHref);
      if (!selection.node || !pageRoot.current) return false;
      const regionId = selection.node === 'boards' ? 'realm-boards-heading' : 'realm-published-heading';
      const heading = document.getElementById(regionId);
      const shelf = heading?.closest('section[aria-labelledby]');
      if (
        !heading?.isConnected ||
        !shelf ||
        shelf.getAttribute('aria-labelledby') !== regionId ||
        !pageRoot.current.contains(shelf)
      )
        return false;

      const selected = selection.focus ? document.getElementById(selection.focus) : null;
      const target = selected && shelf.contains(selected) ? selected : heading;
      if (!target.isConnected || target.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
      target.focus({ preventScroll: true });
      return (
        target.isConnected &&
        document.activeElement === target &&
        receipt.current() &&
        lifetime.current() &&
        lifetime.matchesPage(page)
      );
    },
    [frozen, initialReturn, lifetime, locale, orphaned, page, readable, realmRemoved],
  );
  return onRealmCompleted;
}

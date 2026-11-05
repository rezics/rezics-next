import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { CreatorOffer, CreatorOfferGuard, CreatorOffersData } from './creator-offers';
import { offerReviewStatus, sameOfferObservation } from './creator-offer-review/observation';

type Selection = {
  observed: CreatorOffer;
  trigger: HTMLElement;
};

type ReadingProps = {
  page: CreatorOffersData;
  locale: string;
  cursor?: string | undefined;
  guard?: CreatorOfferGuard | undefined;
};

/** Local reading state lives beneath the existing current-origin boundary, outside command memory. */
export function useCreatorOfferReading({ page, locale, cursor, guard }: ReadingProps) {
  const inspectionId = useId();
  const [scope, setScope] = useState(() => ({ locale, cursor, guard }));
  const [selection, setSelection] = useState<Selection | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const management = useRef(new Map<string, () => void>());
  const live = useRef({ page, locale, cursor, guard, selection, visible: true });
  // The enclosing reader owns account, credentials, source, locale/address and visit retirement.
  // No private selection is stored in its retained command workspace.
  if (scope.locale !== locale || scope.cursor !== cursor || scope.guard !== guard) {
    setScope({ locale, cursor, guard });
    if (selection) setSelection(null);
    live.current.selection = null;
  } else if (selection && (page.kind !== 'ready' || (guard && !guard.isCurrent()))) {
    setSelection(null);
    live.current.selection = null;
  } else {
    live.current.selection = selection;
  }
  live.current.page = page;
  live.current.locale = locale;
  live.current.cursor = cursor;
  live.current.guard = guard;
  const selected = live.current.selection;
  const status = selected && page.kind === 'ready' ? offerReviewStatus(selected.observed, page.offers) : null;

  function current() {
    const value = live.current;
    return (
      value.visible &&
      value.page.kind === 'ready' &&
      value.locale === locale &&
      value.cursor === cursor &&
      value.guard === guard &&
      (!guard || guard.isCurrent())
    );
  }

  useLayoutEffect(() => {
    live.current.visible = true;
    const hide = () => {
      live.current.visible = false;
      live.current.selection = null;
      setSelection(null);
    };
    // BFCache may resume the page; the private selection is intentionally already retired.
    const show = () => {
      live.current.visible = true;
    };
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    return () => {
      live.current.visible = false;
      live.current.selection = null;
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
    };
  }, []);

  useLayoutEffect(() => {
    if (selected && current()) heading.current?.focus();
  }, [selected]);

  function close(returnFocus = true) {
    const previous = live.current.selection;
    if (!current() || !previous) return;
    live.current.selection = null;
    setSelection(null);
    if (returnFocus && previous.trigger.isConnected) previous.trigger.focus();
  }

  return {
    inspectionId,
    heading,
    observed: selected?.observed ?? null,
    status,
    current,
    select(offer: CreatorOffer, trigger: HTMLElement) {
      if (!current()) return;
      // The caller supplies an actual received or retained owned row, never an index or a title.
      const next = { observed: offer, trigger };
      live.current.selection = next;
      setSelection(next);
    },
    selected(offer: CreatorOffer) {
      return !!selected && sameOfferObservation(selected.observed, offer);
    },
    close,
    reviewCurrent() {
      const previous = live.current.selection;
      const received = live.current.page;
      if (!current() || !previous || received.kind !== 'ready') return;
      const latest = received.offers.find((offer) => offer.id === previous.observed.id);
      if (!latest) return;
      const next = { ...previous, observed: latest };
      live.current.selection = next;
      setSelection(next);
    },
    registerManagement(id: string, focus: () => void) {
      management.current.set(id, focus);
      return () => {
        if (management.current.get(id) === focus) management.current.delete(id);
      };
    },
    focusManagement() {
      const previous = live.current.selection;
      if (!current() || !previous) return;
      const focus = management.current.get(previous.observed.id);
      if (!focus) return;
      close(false);
      focus();
    },
  };
}

export type CreatorOfferReading = ReturnType<typeof useCreatorOfferReading>;

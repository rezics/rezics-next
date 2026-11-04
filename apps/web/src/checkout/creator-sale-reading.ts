import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CreatorSale, CreatorSalesData } from './creator-sales';
import { supportedCreatorSaleDeparture } from './creator-sale-destinations';
import { CREATOR_SALE_COMPARISON_LIMIT } from './creator-sales-review/model';

/** The admitted page already validates unique sale identities and the twenty-row bound. */
export function prepareCreatorSaleReading(page: CreatorSalesData): ReadonlyMap<string, CreatorSale> {
  const index = new Map<string, CreatorSale>();
  if (page.kind === 'ready') for (const sale of page.sales) index.set(sale.orderId, sale);
  return index;
}

type Selection = { source: object; id: string; lease: object; version: number };
type Comparison = { source: object; ids: readonly string[]; open: boolean };
type Departure = {
  source: object;
  locale: string;
  cursor: string | undefined;
  orderId: string;
  destination: string;
};
const available = () => true;

/** One supplied reader lifetime owns inspection, comparison and the in-memory departure capture. */
export function useCreatorSaleReading(
  page: CreatorSalesData,
  locale: string,
  cursor: string | undefined,
  owner: object | undefined,
  isCurrent: () => boolean = available,
) {
  const sequence = useRef(0);
  const reading = useMemo(
    () => ({ source: {}, index: prepareCreatorSaleReading(page), version: ++sequence.current }),
    [page, locale, cursor, owner],
  );
  const opener = useRef<HTMLElement | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [returned, setReturned] = useState(false);
  const [suspended, setSuspended] = useState(false);
  const mounted = useRef(true);
  const departure = useRef<Departure | null>(null);
  const selectionSequence = useRef(0);
  const live = useRef<{
    source: object;
    selection: Selection | null;
    comparison: Comparison | null;
    isCurrent: () => boolean;
    suspended: boolean;
  }>({ source: reading.source, selection: null, comparison: null, isCurrent, suspended: false });
  const selected = selection?.source === reading.source && !suspended && isCurrent() ? selection : null;
  const compared = comparison?.source === reading.source && !suspended && isCurrent() ? comparison : null;
  if (live.current.source !== reading.source) {
    opener.current = null;
    departure.current = null;
    if (returned) setReturned(false);
  }
  live.current = { source: reading.source, selection: selected, comparison: compared, isCurrent, suspended };
  if (selection && selection.source !== reading.source) setSelection(null);
  if (comparison && comparison.source !== reading.source) setComparison(null);
  const sourceIsCurrent = () =>
    mounted.current && !live.current.suspended && live.current.source === reading.source && live.current.isCurrent();
  const selectionIsCurrent = () => sourceIsCurrent() && !!selected && live.current.selection?.lease === selected.lease;

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      live.current.selection = null;
      departure.current = null;
      opener.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    // Browser Back can resume the same document. A new document has no private return capture.
    const hide = () => {
      live.current.suspended = true;
      live.current.selection = null;
      setSuspended(true);
    };
    const show = () => {
      live.current.suspended = false;
      setSuspended(false);
      const captured = departure.current;
      departure.current = null;
      if (!captured) {
        setSelection(null);
        setComparison(null);
        setReturned(false);
        return;
      }
      const sameAddress =
        window.location.pathname === `/${locale}/creator/sales` &&
        new URLSearchParams(window.location.search).get('cursor') === (cursor ?? null);
      if (
        !sourceIsCurrent() ||
        !sameAddress ||
        captured.source !== reading.source ||
        captured.locale !== locale ||
        captured.cursor !== cursor ||
        !reading.index.has(captured.orderId)
      ) {
        setSelection(null);
        setComparison(null);
        setReturned(false);
        return;
      }
      const next = {
        source: reading.source,
        id: captured.orderId,
        lease: {},
        version: ++selectionSequence.current,
      };
      live.current.selection = next;
      setSelection(next);
      setReturned(true);
    };
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    return () => {
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
    };
  }, [reading, locale, cursor]);

  const close = () => {
    if (!selectionIsCurrent()) return;
    live.current.selection = null;
    departure.current = null;
    setSelection(null);
    setReturned(false);
    if (opener.current?.isConnected) opener.current.focus();
    else document.getElementById('creator-sales-review-heading')?.focus();
    opener.current = null;
  };
  const select = (id: string, element: HTMLElement) => {
    if (!sourceIsCurrent() || !reading.index.has(id)) return;
    const next = { source: reading.source, id, lease: {}, version: ++selectionSequence.current };
    opener.current = element;
    departure.current = null;
    live.current.selection = next;
    setSelection(next);
    setReturned(false);
  };
  const changeComparison = (ids: readonly string[], open = false) => {
    if (!sourceIsCurrent()) return;
    const next = { source: reading.source, ids, open };
    live.current.comparison = next;
    setComparison(next);
  };
  return {
    sale: selected ? (reading.index.get(selected.id) ?? null) : null,
    select,
    close,
    isCurrent: selectionIsCurrent,
    sourceIsCurrent,
    selectedId: selected?.id,
    selectionVersion: selected?.version,
    sourceVersion: reading.version,
    returned,
    comparisonIds: compared?.ids ?? [],
    comparisonSales: (compared?.ids ?? []).flatMap((id) => {
      const sale = reading.index.get(id);
      return sale ? [sale] : [];
    }),
    comparisonOpen: compared?.open ?? false,
    toggleComparison(id: string) {
      if (!sourceIsCurrent() || !reading.index.has(id)) return;
      const ids = live.current.comparison?.ids ?? [];
      if (ids.includes(id)) changeComparison(ids.filter((value) => value !== id));
      else if (ids.length < CREATOR_SALE_COMPARISON_LIMIT) changeComparison([...ids, id]);
    },
    clearComparison() {
      changeComparison([]);
    },
    openComparison() {
      const ids = live.current.comparison?.ids ?? [];
      if (ids.length >= 2) changeComparison(ids, true);
    },
    closeComparison() {
      changeComparison(live.current.comparison?.ids ?? []);
    },
    prepareDeparture(href: string): boolean {
      if (!selectionIsCurrent() || !selected) return false;
      const sale = reading.index.get(selected.id);
      if (!sale) return false;
      const destination = supportedCreatorSaleDeparture(sale, locale, href, window.location.origin);
      if (!destination) return false;
      departure.current = { source: reading.source, locale, cursor, orderId: selected.id, destination };
      return true;
    },
  };
}

export type CreatorSaleReading = ReturnType<typeof useCreatorSaleReading>;

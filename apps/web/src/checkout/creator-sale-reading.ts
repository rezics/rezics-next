import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CreatorSale, CreatorSalesData } from './creator-sales';

/** The admitted page already validates unique sale identities and the twenty-row bound. */
export function prepareCreatorSaleReading(page: CreatorSalesData): ReadonlyMap<string, CreatorSale> {
  const index = new Map<string, CreatorSale>();
  if (page.kind === 'ready') for (const sale of page.sales) index.set(sale.orderId, sale);
  return index;
}

type Selection = { source: object; id: string; lease: object };
const available = () => true;

/** Retains references to one page, an opaque source token and one selected identity, never page history. */
export function useCreatorSaleReading(
  page: CreatorSalesData,
  locale: string,
  cursor: string | undefined,
  owner: object | undefined,
  isCurrent: () => boolean = available,
) {
  const reading = useMemo(
    () => ({ source: {}, index: prepareCreatorSaleReading(page) }),
    [page, locale, cursor, owner],
  );
  const opener = useRef<HTMLElement | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      opener.current = null;
    };
  }, []);
  const live = useRef<{ source: object; selection: Selection | null; isCurrent: () => boolean }>({
    source: reading.source,
    selection: null,
    isCurrent,
  });
  const selected = selection?.source === reading.source ? selection : null;
  if (live.current.source !== reading.source) opener.current = null;
  live.current = { source: reading.source, selection: selected, isCurrent };
  if (selection && !selected) setSelection(null);
  const sourceIsCurrent = () => mounted.current && live.current.source === reading.source && live.current.isCurrent();
  const selectionIsCurrent = () => sourceIsCurrent() && !!selected && live.current.selection?.lease === selected.lease;
  const close = () => {
    if (!selectionIsCurrent()) return;
    live.current.selection = null;
    setSelection(null);
    if (opener.current?.isConnected) opener.current.focus();
    opener.current = null;
  };
  return {
    sale: selected ? (reading.index.get(selected.id) ?? null) : null,
    select(id: string, element: HTMLElement) {
      if (!sourceIsCurrent() || !reading.index.has(id)) return;
      const next = { source: reading.source, id, lease: {} };
      opener.current = element;
      live.current.selection = next;
      setSelection(next);
    },
    close,
    isCurrent: selectionIsCurrent,
    selectedId: selected?.id,
  };
}

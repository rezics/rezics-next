import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../../paraglide/messages.js';
import type { Item } from '../../pages/overview';
import type { CreditVisit } from './model';
import { creditReturn, creditReturnMatches } from './navigation';

/** Lives inside the association's disclosure gate, including its dialog portal. */
export function CreditInspectionAction({
  statement,
  onOpen,
  onRetire,
  children,
  locale,
}: {
  statement: string;
  onOpen: (trigger: HTMLButtonElement) => void;
  onRetire: () => void;
  children?: ReactNode;
  locale: string;
}) {
  const retire = useRef(onRetire);
  retire.current = onRetire;
  useEffect(() => () => retire.current(), []);
  return (
    <>
      <Button
        variant="outline"
        className="mt-2 min-h-11 whitespace-normal"
        data-credit-statement={statement}
        onClick={(event) => onOpen(event.currentTarget)}
      >
        {m.credit_inspect({}, { locale: locale as never })}
      </Button>
      {children}
    </>
  );
}

/** Only a freshly mounted current page can consume a return locator; hash changes never revive a reading. */
export function CreditVisitReturn({
  visit,
  items,
  root,
  open,
  retired,
  locale,
}: {
  visit: CreditVisit;
  items: Item[];
  root: RefObject<HTMLDivElement | null>;
  open: (item: Item, trigger: HTMLButtonElement) => void;
  retired: boolean;
  locale: string;
}) {
  const consumed = useRef(false);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (consumed.current || !root.current) return;
    const url = new URL(window.location.href);
    const locator = creditReturn(url.hash);
    if (!locator || url.pathname.split('/')[3] !== visit.person || url.searchParams.get('node') !== visit.node) return;
    consumed.current = true;
    const selectedCursor = visit.stream.kind === 'links' ? visit.stream.cursor : undefined;
    const item = items.find((item) => item.credit && creditReturnMatches(locator, visit, item.credit));
    const exact =
      item &&
      !item.gated &&
      (url.searchParams.get('cursor') ?? undefined) === selectedCursor &&
      (url.searchParams.get('realm') ?? undefined) === visit.realm;
    const trigger = exact
      ? [...root.current.querySelectorAll<HTMLButtonElement>('button[data-credit-statement]')].find(
          (button) => button.dataset.creditStatement === item.statement,
        )
      : undefined;
    const active = document.activeElement;
    const mayFocus = !active || active === document.body || root.current.contains(active);
    if (trigger && item) {
      // Opening moves focus into the shared dialog; deliberate user movement always wins.
      if (mayFocus) open(item, trigger);
    } else {
      setUnavailable(true);
      if (mayFocus) root.current.focus();
    }
  }, [visit, items, root, open]);
  useEffect(() => {
    if (!retired || !root.current) return;
    const active = document.activeElement;
    if (!active || active === document.body) root.current.focus();
  }, [retired, root]);
  return unavailable || retired ? (
    <p role="status">{m.credit_return_unavailable({}, { locale: locale as never })}</p>
  ) : null;
}

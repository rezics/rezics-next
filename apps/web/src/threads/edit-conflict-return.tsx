import { useEffect, useRef } from 'react';

type TextSelection = {
  element: HTMLInputElement | HTMLTextAreaElement;
  start: number;
  end: number;
  direction: 'forward' | 'backward' | 'none';
};
type ReturnVisit = {
  origin: HTMLElement | null;
  trigger: HTMLElement;
  range: Range | null;
  text: TextSelection | null;
  replaced: boolean;
  abandoned: boolean;
};

/** The dialog owns the return; the rich editor continues to own its selection and transactions. */
export function useConflictReturn({
  returningFocus,
  admitted,
}: {
  returningFocus: () => HTMLElement | null;
  admitted: () => boolean;
}) {
  const visit = useRef<ReturnVisit | null>(null);
  const popup = useRef<HTMLElement | null>(null);
  const latest = useRef({ returningFocus, admitted });
  latest.current = { returningFocus, admitted };

  useEffect(() => {
    const newerAction = (event: Event) => {
      const plan = visit.current;
      const target = event.target;
      if (!plan || !(target instanceof Node)) return;
      if (popup.current?.contains(target) || plan.trigger.contains(target)) return;
      // A pointer/focus action outside the closing popup wins over its delayed finalFocus.
      plan.abandoned = true;
      plan.range = null;
      plan.text = null;
    };
    document.addEventListener('pointerdown', newerAction, true);
    document.addEventListener('focusin', newerAction, true);
    return () => {
      document.removeEventListener('pointerdown', newerAction, true);
      document.removeEventListener('focusin', newerAction, true);
      visit.current = null;
      popup.current = null;
    };
  }, []);

  return {
    popup,
    capture(trigger: HTMLElement) {
      const origin = latest.current.returningFocus();
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      let text: TextSelection | null = null;
      if (origin && (origin.tagName === 'INPUT' || origin.tagName === 'TEXTAREA')) {
        const element = origin as HTMLInputElement | HTMLTextAreaElement;
        if (element.selectionStart !== null && element.selectionEnd !== null)
          text = {
            element,
            start: element.selectionStart,
            end: element.selectionEnd,
            direction: element.selectionDirection ?? 'none',
          };
      }
      visit.current = {
        origin,
        trigger,
        range: range && origin?.contains(range.commonAncestorContainer) ? range.cloneRange() : null,
        text,
        replaced: false,
        abandoned: false,
      };
    },
    replacing() {
      if (!visit.current) return;
      visit.current.replaced = true;
      visit.current.range = null;
      visit.current.text = null;
    },
    retire() {
      visit.current = null;
    },
    resolve(): HTMLElement | false {
      const plan = visit.current;
      visit.current = null;
      if (!plan || plan.abandoned || !latest.current.admitted()) return false;
      const active = document.activeElement;
      if (
        active &&
        active !== document.body &&
        active !== plan.trigger &&
        active !== plan.origin &&
        !popup.current?.contains(active)
      )
        return false;
      const origin = plan.replaced ? latest.current.returningFocus() : plan.origin;
      const target = origin?.isConnected ? origin : plan.trigger.isConnected ? plan.trigger : null;
      if (!target) return false;
      if (!plan.replaced && target === plan.origin) {
        if (plan.text?.element.isConnected) {
          plan.text.element.setSelectionRange(plan.text.start, plan.text.end, plan.text.direction);
        } else if (plan.range?.startContainer.isConnected && plan.range.endContainer.isConnected) {
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(plan.range);
        }
      }
      return target;
    },
  };
}

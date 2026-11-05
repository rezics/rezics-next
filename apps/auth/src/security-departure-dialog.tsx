import { useLayoutEffect, useRef } from 'react';
import { AuthButton as Button } from './button';
import { m } from './paraglide/messages.js';

type Props = {
  onStay: () => void;
  onLeave: () => void;
  captureFocus: (target: HTMLElement | null) => void;
};

/** A finite decision; operation lifetime and focus restoration belong to Security. */
export function SecurityDepartureDialog({ onStay, onLeave, captureFocus }: Props) {
  const overlay = useRef<HTMLDivElement>(null);
  const stay = useRef<HTMLButtonElement>(null);
  const leave = useRef<HTMLButtonElement>(null);
  const decided = useRef(false);
  const handlers = useRef({ onStay, onLeave, captureFocus });
  handlers.current = { onStay, onLeave, captureFocus };

  function choose(choice: 'onStay' | 'onLeave') {
    // Escape followed by a queued click must not resolve the same decision twice.
    if (decided.current) return;
    decided.current = true;
    handlers.current[choice]();
  }

  useLayoutEffect(() => {
    const layer = overlay.current!;
    const doc = layer.ownerDocument;
    const active = doc.activeElement;
    handlers.current.captureFocus(active instanceof HTMLElement && active !== doc.body ? active : null);
    decided.current = false;

    // Keep the dialog in the page tree, excluding siblings at every ancestor level.
    const background = new Map<Element, string | null>();
    for (let branch: Element = layer; branch.parentElement; branch = branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling === branch) continue;
        background.set(sibling, sibling.getAttribute('inert'));
        sibling.setAttribute('inert', '');
      }
      if (branch.parentElement === doc.body) break;
    }
    const style = doc.body.style;
    const scroll = ['overflow', 'overflow-x', 'overflow-y'].map((name) => ({
      name,
      value: style.getPropertyValue(name),
      priority: style.getPropertyPriority(name),
    }));
    style.setProperty('overflow', 'hidden');

    function containFocus(event: FocusEvent) {
      if (!layer.contains(event.target as Node)) stay.current!.focus();
    }
    function containPointer(event: Event) {
      if (layer.contains(event.target as Node)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    function keyboard(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        choose('onStay');
      } else if (event.key === 'Tab') {
        event.preventDefault();
        event.stopImmediatePropagation();
        const next = event.shiftKey
          ? doc.activeElement === stay.current ? leave.current : stay.current
          : doc.activeElement === leave.current ? stay.current : leave.current;
        next!.focus();
      }
    }
    doc.addEventListener('focusin', containFocus, true);
    doc.addEventListener('keydown', keyboard, true);
    doc.addEventListener('pointerdown', containPointer, true);
    doc.addEventListener('click', containPointer, true);
    stay.current!.focus();

    let cleaned = false;
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      doc.removeEventListener('focusin', containFocus, true);
      doc.removeEventListener('keydown', keyboard, true);
      doc.removeEventListener('pointerdown', containPointer, true);
      doc.removeEventListener('click', containPointer, true);
      window.removeEventListener('pagehide', cleanup);
      for (const [element, inert] of background) {
        if (inert === null) element.removeAttribute('inert');
        else element.setAttribute('inert', inert);
      }
      for (const { name } of scroll) style.removeProperty(name);
      for (const { name, value, priority } of scroll) {
        if (value) style.setProperty(name, value, priority);
      }
    }
    window.addEventListener('pagehide', cleanup);
    return cleanup;
  }, []);

  return (
    <div ref={overlay} className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="security-departure-heading"
        aria-describedby="security-departure-description"
        className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto overscroll-contain rounded-lg border bg-background p-6 text-foreground shadow-xl wrap-anywhere"
      >
        <h2 id="security-departure-heading" className="text-lg font-semibold">
          {m.auth_security_departure_heading()}
        </h2>
        <p id="security-departure-description" className="mt-2 text-sm">
          {m.auth_security_departure_description()}
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-2 [&>button]:h-auto [&>button]:min-h-9 [&>button]:whitespace-normal">
          <Button ref={stay} type="button" variant="outline" data-stay onClick={() => choose('onStay')}>
            {m.auth_security_departure_stay()}
          </Button>
          <Button ref={leave} type="button" data-leave onClick={() => choose('onLeave')}>
            {m.auth_security_departure_leave()}
          </Button>
        </div>
      </div>
    </div>
  );
}

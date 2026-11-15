import { useCallback, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@rezics/ui/shadcn/alert-dialog';
import { m } from '../../paraglide/messages.js';

type CatalogueNavigationDecisionProps = {
  open: boolean;
  locale: string;
  title: string;
  onStay: () => void;
  onLeave: () => void;
  fallbackFocus: () => HTMLElement | null;
};

function isVisible(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected || element.matches(':disabled') || element.closest('[hidden], [inert], [aria-hidden="true"]'))
    return false;
  const view = element.ownerDocument.defaultView;
  const style = view?.getComputedStyle(element);
  return !!style && style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}

export function CatalogueNavigationDecision({
  open,
  locale,
  title,
  onStay,
  onLeave,
  fallbackFocus,
}: CatalogueNavigationDecisionProps) {
  const origin = useRef<HTMLElement | null>(null);
  const stayButton = useRef<HTMLButtonElement | null>(null);
  const fallback = useRef(fallbackFocus);
  const resolution = useRef<'stay' | 'leave' | null>(null);
  const wasOpen = useRef(false);
  fallback.current = fallbackFocus;
  const o = { locale: locale as never };

  const captureOrigin = useCallback(
    (content: HTMLElement | null) => {
      if (!content || !open || origin.current) return;
      const document = content.ownerDocument;
      const active = document.activeElement;
      const HTMLElementConstructor = document.defaultView?.HTMLElement;
      if (
        HTMLElementConstructor &&
        active instanceof HTMLElementConstructor &&
        active !== document.body &&
        !content.contains(active)
      )
        origin.current = active;
    },
    [open],
  );

  const stay = () => {
    if (!open || resolution.current) return;
    resolution.current = 'stay';
    onStay();
  };

  const leave = () => {
    if (!open || resolution.current) return;
    resolution.current = 'leave';
    onLeave();
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) stay();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    event.stopPropagation();
    stay();
  };

  useLayoutEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    if (resolution.current === 'stay') {
      const initiatingControl = origin.current;
      if (isVisible(initiatingControl)) {
        initiatingControl.focus({ preventScroll: true });
        if (initiatingControl.ownerDocument.activeElement === initiatingControl) {
          resolution.current = null;
          origin.current = null;
          return;
        }
      }
      const heading = fallback.current();
      if (isVisible(heading)) {
        if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
    }
    resolution.current = null;
    origin.current = null;
  }, [open]);

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent
        ref={captureOrigin}
        initialFocus={stayButton}
        finalFocus={false}
        onKeyDown={handleKeyDown}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{m.release_fidelity_leave({}, o)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="sticky bottom-0 z-10 -mx-6 -mb-6 flex-col border-t bg-popover p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:flex-row">
          <AlertDialogCancel
            ref={stayButton}
            variant="default"
            className="h-auto min-h-7 w-full max-w-full whitespace-normal break-words [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:w-auto"
          >
            {m.library_collection_draft_navigation_stay({}, o)}
          </AlertDialogCancel>
          <AlertDialogAction
            type="button"
            variant="outline"
            onClick={leave}
            className="h-auto min-h-7 w-full max-w-full whitespace-normal break-words [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:w-auto"
          >
            {m.library_collection_draft_navigation_leave({}, o)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

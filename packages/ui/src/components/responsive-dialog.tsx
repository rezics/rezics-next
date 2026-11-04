import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { BottomSheet } from './bottom-sheet';
import { useIsMobile } from '../hooks/use-mobile';
import { Button } from '../shadcn/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../shadcn/dialog';

type ResponsiveFocus = () => HTMLElement | false;

/**
 * Use the installed Dialog and Drawer primitives for one responsive, controlled interaction.
 * The stable portal keeps its content tree mounted while its presentation moves between primitives.
 */
export function ResponsiveDialog({
  open,
  onOpenChange,
  onOpenChangeComplete,
  title,
  description,
  closeLabel,
  finalFocus,
  id,
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete?: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  closeLabel: string;
  finalFocus: ResponsiveFocus;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  const mobile = useIsMobile();
  const mobileRef = useRef(mobile);
  const openRef = useRef(open);
  const episode = useRef(0);
  const previousOpen = useRef(open);
  const closingEpisode = useRef<number | null>(null);
  const allowReturnFocus = useRef(true);
  const finalFocusRef = useRef(finalFocus);
  const focusedControlId = useRef<string | null>(null);
  const textSelection = useRef<{
    control: HTMLInputElement | HTMLTextAreaElement;
    start: number;
    end: number;
    direction: 'forward' | 'backward' | 'none' | null;
  } | null>(null);
  const controlSequence = useRef(0);
  const transferSequence = useRef(0);
  const switching = useRef(false);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [mount, setMount] = useState<HTMLDivElement | null>(null);
  const [portalHost] = useState<HTMLDivElement | null>(() =>
    typeof document === 'undefined' ? null : document.createElement('div'),
  );
  const [portalReady, setPortalReady] = useState(false);

  mobileRef.current = mobile;
  openRef.current = open;
  finalFocusRef.current = finalFocus;
  if (previousOpen.current !== open) {
    if (open) {
      episode.current += 1;
      closingEpisode.current = null;
      allowReturnFocus.current = true;
      focusedControlId.current = null;
    } else {
      closingEpisode.current = episode.current;
      allowReturnFocus.current = true;
    }
    previousOpen.current = open;
  }
  const renderedEpisode = episode.current;

  // mobileRef is updated during render, so compare against the last rendered presentation separately.
  const previousMobile = useRef(mobile);
  if (previousMobile.current !== mobile) {
    // Read before React removes the outgoing primitive. Input types without text selection
    // return null; native date/number controls keep their own installed behavior.
    const focused = typeof document === 'undefined' ? null : document.activeElement;
    if (focused && portalHost?.contains(focused) && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA')) {
      const control = focused as HTMLInputElement | HTMLTextAreaElement;
      textSelection.current =
        control.selectionStart === null || control.selectionEnd === null
          ? null
          : {
              control,
              start: control.selectionStart,
              end: control.selectionEnd,
              direction: control.selectionDirection,
            };
    } else textSelection.current = null;
    previousMobile.current = mobile;
    switching.current = true;
    transferSequence.current += 1;
  }

  const setContentMount = useCallback((node: HTMLDivElement | null) => {
    mountRef.current = node;
    setMount(node);
  }, []);

  useLayoutEffect(() => {
    if (portalHost) setPortalReady(true);
  }, [portalHost]);

  useEffect(() => {
    function onFocusIn(event: FocusEvent) {
      const element = event.target instanceof HTMLElement ? event.target : null;
      if (!element) return;
      const surface = mountRef.current?.closest<HTMLElement>('[role="dialog"]');
      const focusedSurface = element.closest<HTMLElement>('[role="dialog"]');

      if (surface && focusedSurface === surface) {
        if (switching.current && !portalHost?.contains(element)) return;
        let identity = element.getAttribute('data-responsive-control-id');
        if (!identity) {
          identity = `responsive-control-${++controlSequence.current}`;
          element.setAttribute('data-responsive-control-id', identity);
        }
        focusedControlId.current = identity;
        return;
      }

      if (switching.current) return;
      const returnTarget = resolveFocusTarget(finalFocusRef.current);
      if (closingEpisode.current !== null && element !== returnTarget) allowReturnFocus.current = false;
      focusedControlId.current = null;
    }

    document.addEventListener('focusin', onFocusIn, true);
    return () => document.removeEventListener('focusin', onFocusIn, true);
  }, [portalHost]);

  useLayoutEffect(() => {
    if (!portalHost || !mount) return;
    if (portalHost.parentElement !== mount) mount.appendChild(portalHost);

    const transfer = switching.current;
    if (!transfer)
      return () => {
        if (portalHost.parentElement === mount) portalHost.remove();
      };

    const transferId = transferSequence.current;
    const restore = () => {
      if (transferId !== transferSequence.current) return;
      if (openRef.current && mobileRef.current === mobile && renderedEpisode === episode.current) {
        const identity = focusedControlId.current;
        const surface = mountRef.current?.closest<HTMLElement>('[role="dialog"]');
        const control = identity
          ? [...(surface?.querySelectorAll<HTMLElement>('[data-responsive-control-id]') ?? [])].find(
              (element) => element.getAttribute('data-responsive-control-id') === identity,
            )
          : undefined;
        control?.focus({ preventScroll: true });
        const selection = textSelection.current;
        if (selection && selection.control === control && control.isConnected) {
          selection.control.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined);
        }
      }
      textSelection.current = null;
      switching.current = false;
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
    else queueMicrotask(restore);
    return () => {
      if (portalHost.parentElement === mount) portalHost.remove();
    };
  }, [mount, mobile, open, portalHost, renderedEpisode]);

  function isCurrentShell(shellMobile: boolean, shellEpisode: number) {
    return shellMobile === mobileRef.current && shellEpisode === episode.current;
  }

  function changeOpen(next: boolean, shellMobile: boolean, shellEpisode: number) {
    if (!isCurrentShell(shellMobile, shellEpisode) || next === openRef.current) return;
    if (next) {
      closingEpisode.current = null;
      allowReturnFocus.current = true;
    } else {
      closingEpisode.current = shellEpisode;
      allowReturnFocus.current = true;
    }
    onOpenChange(next);
  }

  function completeOpenChange(next: boolean, shellMobile: boolean, shellEpisode: number) {
    if (!isCurrentShell(shellMobile, shellEpisode)) return;
    if (next ? !openRef.current : closingEpisode.current !== shellEpisode) return;
    onOpenChangeComplete?.(next);
  }

  function finalFocusFor(shellMobile: boolean, shellEpisode: number) {
    return () => {
      if (
        !isCurrentShell(shellMobile, shellEpisode) ||
        openRef.current ||
        closingEpisode.current !== shellEpisode ||
        !allowReturnFocus.current
      )
        return false;
      const target = resolveFocusTarget(finalFocusRef.current);
      return target && target.isConnected ? target : false;
    };
  }

  const shell = mobile ? (
    <BottomSheet
      {...(id === undefined ? {} : { id })}
      open={open}
      onOpenChange={(next) => changeOpen(next, true, renderedEpisode)}
      onOpenChangeComplete={(next) => completeOpenChange(next, true, renderedEpisode)}
      title={title}
      description={description}
      closeLabel={closeLabel}
      closeControlId="responsive-dialog-close"
      finalFocus={finalFocusFor(true, renderedEpisode)}
    >
      <div ref={setContentMount} className="min-h-0 min-w-0" />
    </BottomSheet>
  ) : (
    <Dialog
      open={open}
      onOpenChange={(next) => changeOpen(next, false, renderedEpisode)}
      onOpenChangeComplete={(next) => completeOpenChange(next, false, renderedEpisode)}
    >
      <DialogContent
        id={id}
        showCloseButton={false}
        className={`max-h-[calc(100dvh-2rem)] min-w-0 overflow-y-auto sm:max-w-lg ${className ?? ''}`}
        finalFocus={finalFocusFor(false, renderedEpisode)}
      >
        <DialogHeader className="flex-row items-center justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <DialogTitle className="min-w-0 break-words">{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </div>
          <DialogClose
            render={
              <Button
                type="button"
                variant="ghost"
                className="min-h-11 shrink-0"
                data-responsive-control-id="responsive-dialog-close"
              />
            }
          >
            {closeLabel}
          </DialogClose>
        </DialogHeader>
        <div ref={setContentMount} className="min-w-0" />
      </DialogContent>
    </Dialog>
  );

  return (
    <>
      {shell}
      {portalReady && portalHost ? createPortal(children, portalHost) : null}
    </>
  );
}

function resolveFocusTarget(target: ResponsiveFocus): HTMLElement | false {
  return target();
}

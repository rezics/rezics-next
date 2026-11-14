import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { HomeFeedFilterSummary, type HomeFeedFilterSummary as Selection } from './home-feed-filter-summary';
import type { FeedStream } from './home-feed-read';

const focusable = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]';
function targets(panel: HTMLElement) {
  return [...panel.querySelectorAll<HTMLElement>(focusable)].filter((node) => !node.closest('[hidden], [inert]'));
}

function visibleFocusTarget(node: HTMLElement | null): node is HTMLElement {
  if (!node?.isConnected || node.matches(':disabled') || node.closest('[hidden], [inert], [aria-hidden="true"]'))
    return false;
  const style = node.ownerDocument.defaultView?.getComputedStyle(node);
  return node.getClientRects().length > 0 && style?.display !== 'none' && style?.visibility !== 'hidden';
}

/** One mounted control tree: changing the surface never remounts or reads a selector. */
export function HomeFeedControls({
  locale,
  stream,
  open,
  onOpenChange,
  id,
  panelRef,
  selections,
  onClear,
  legacySummary,
  children,
}: {
  locale: string;
  stream: FeedStream;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  id: string;
  panelRef: RefObject<HTMLDivElement | null>;
  selections: readonly Selection[];
  onClear?: (() => void) | undefined;
  /** Compatibility for prepared reading/recovery callers; the native adapter uses typed selections. */
  legacySummary?: readonly ReactNode[] | undefined;
  children: ReactNode;
}) {
  const options = { locale: locale as Locale };
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const closeIntent = useRef<'restore' | 'preserve' | null>(null);
  const [phone, setPhone] = useState(false);
  const changeOpen = useCallback(
    (next: boolean, intent: 'restore' | 'preserve' = 'preserve') => {
      closeIntent.current = next ? null : intent;
      onOpenChange(next);
    },
    [onOpenChange],
  );
  useEffect(() => {
    const media = window.matchMedia('(max-width: 639px)');
    const update = () => setPhone(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    const panel = popup.current;
    if (!panel) return;
    if (returnTo.current === null) {
      const document = panel.ownerDocument;
      const active = document.activeElement;
      returnTo.current =
        active instanceof HTMLElement && active !== document.body && active !== document.documentElement
          ? active
          : trigger.current;
    }
    closeIntent.current = null;
    // Focus the existing selector first, including recovery opened from an empty result.
    (panelRef.current?.querySelector<HTMLElement>(focusable) ?? close.current ?? panel).focus({ preventScroll: true });
  }, [open, panelRef]);
  useEffect(() => {
    if (!open || !phone || !popup.current) return;
    const panel = popup.current;
    const document = panel.ownerDocument;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Inert only sibling branches: the sheet remains in the same React tree as its selectors.
    const retired: Array<{ node: HTMLElement; inert: boolean }> = [];
    let branch: HTMLElement = panel;
    while (branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (
          sibling === branch ||
          !(sibling instanceof HTMLElement) ||
          sibling.hasAttribute('data-home-filter-backdrop')
        )
          continue;
        retired.push({ node: sibling, inert: sibling.inert });
        sibling.inert = true;
      }
      branch = branch.parentElement;
      if (branch === document.body) break;
    }
    const contain = (event: FocusEvent) => {
      if (event.target instanceof Node && !panel.contains(event.target)) {
        (targets(panel)[0] ?? panel).focus();
      }
    };
    document.addEventListener('focusin', contain);
    return () => {
      document.removeEventListener('focusin', contain);
      document.body.style.overflow = previousOverflow;
      for (const { node, inert } of retired) node.inert = inert;
    };
  }, [open, phone]);
  useEffect(() => {
    if (!open) return;
    const document = popup.current!.ownerDocument;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !wrapper.current?.contains(event.target)) changeOpen(false, 'preserve');
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        changeOpen(false, 'restore');
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, changeOpen]);
  useEffect(() => {
    if (!open || !popup.current) return;
    const panel = popup.current;
    const document = panel.ownerDocument;
    return () => {
      if (!panel.isConnected || !panel.hidden) return;
      const intent = closeIntent.current;
      closeIntent.current = null;
      const returnTarget = returnTo.current;
      returnTo.current = null;
      if (intent !== 'restore') return;
      const focusedAtClose = document.activeElement;
      const focusWasInPanel = focusedAtClose instanceof Node && panel.contains(focusedAtClose);
      const focusWasClearedByClose = focusedAtClose === document.body || focusedAtClose === document.documentElement;
      if (!focusWasInPanel && !focusWasClearedByClose) return;
      queueMicrotask(() => {
        if (!panel.isConnected || !panel.hidden || document.activeElement !== focusedAtClose) return;
        const currentTrigger = trigger.current;
        const target = visibleFocusTarget(returnTarget)
          ? returnTarget
          : visibleFocusTarget(currentTrigger)
            ? currentTrigger
            : null;
        target?.focus({ preventScroll: true });
      });
    };
  }, [open]);
  const streamLabel = stream === 'following' ? m.home_feed_following({}, options) : m.nav_home({}, options);
  const context = selections.length ? m.home_filter_context({ stream: streamLabel }, options) : streamLabel;
  return (
    <section ref={wrapper} aria-label={m.search_filters({}, options)} className="relative min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          ref={trigger}
          type="button"
          variant="outline"
          className="min-h-11 whitespace-normal"
          aria-expanded={open}
          aria-controls={id}
          aria-haspopup="dialog"
          onClick={() => changeOpen(!open, 'preserve')}
        >
          {open ? m.search_close_filters({}, options) : m.search_filters({}, options)}
          {selections.length ? (
            <span aria-hidden="true" className="rounded-full bg-primary/10 px-2">
              {new Intl.NumberFormat(locale).format(selections.length)}
            </span>
          ) : null}
        </Button>
        <p className="min-w-0 text-sm text-muted-foreground">{context}</p>
      </div>
      {selections.length || legacySummary?.length ? (
        <div className="space-y-2 border-t border-border pt-3">
          <h2 className="text-sm font-semibold">{m.refinement_selected({}, options)}</h2>
          {selections.length ? (
            <HomeFeedFilterSummary selections={selections} locale={locale} onClear={onClear} fallback={trigger} />
          ) : null}
          {legacySummary?.length ? (
            <ul
              aria-label={m.refinement_selected({}, options)}
              className="flex flex-wrap gap-2 text-sm text-muted-foreground"
            >
              {legacySummary.map((label, index) => (
                <li key={index}>{label}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {open && phone ? (
        <div
          data-home-filter-backdrop
          aria-hidden="true"
          className="fixed inset-0 z-40 bg-black/40"
          onClick={() => changeOpen(false, 'preserve')}
        />
      ) : null}
      <div
        ref={popup}
        id={id}
        hidden={!open}
        role="dialog"
        aria-modal={phone || undefined}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-help`}
        tabIndex={-1}
        data-home-filter-surface={phone ? 'sheet' : 'panel'}
        className={
          open
            ? 'fixed inset-x-0 bottom-0 z-50 flex max-h-[90dvh] min-w-0 flex-col rounded-t-2xl border border-border bg-popover text-popover-foreground shadow-xl outline-none [overflow-wrap:anywhere] sm:absolute sm:inset-x-auto sm:top-full sm:bottom-auto sm:left-0 sm:mt-2 sm:max-h-[min(80dvh,48rem)] sm:w-[min(36rem,calc(100vw-3rem))] sm:rounded-2xl'
            : 'hidden'
        }
        onKeyDown={(event) => {
          if (!phone || event.key !== 'Tab' || !popup.current) return;
          const buttons = targets(popup.current);
          const first = buttons[0];
          const last = buttons.at(-1);
          const active = popup.current.ownerDocument.activeElement;
          if (!first) {
            event.preventDefault();
            popup.current.focus();
          } else if (event.shiftKey && (active === first || active === popup.current)) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="shrink-0 space-y-2 border-b border-border p-4">
          <div className="flex items-start justify-between gap-3">
            <h2 id={`${id}-title`} className="pt-2 text-base font-semibold">
              {m.home_filter_title({}, options)}
            </h2>
            <Button
              ref={close}
              type="button"
              variant="ghost"
              className="min-h-11 whitespace-normal"
              onClick={() => changeOpen(false, 'restore')}
            >
              {m.search_close_filters({}, options)}
            </Button>
          </div>
          <p id={`${id}-help`} className="text-sm text-muted-foreground">
            {m.home_filter_help({}, options)}
          </p>
        </div>
        <div ref={panelRef} className="min-h-0 space-y-5 overflow-y-auto overscroll-contain p-4">
          {children}
        </div>
        <div className="max-h-[35dvh] shrink-0 space-y-2 overflow-y-auto border-t border-border p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <p className="text-sm text-muted-foreground">{context}</p>
          {selections.length ? (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">{m.refinement_selected({}, options)}</h3>
              <HomeFeedFilterSummary selections={selections} locale={locale} onClear={onClear} fallback={close} />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

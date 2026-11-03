import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { HomeFeedFilterSummary, type HomeFeedFilterSummary as Selection } from './home-feed-filter-summary';
import type { FeedStream } from './home-feed-read';

const focusable = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]';
function targets(panel: HTMLElement) {
  return [...panel.querySelectorAll<HTMLElement>(focusable)].filter((node) => !node.closest('[hidden], [inert]'));
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
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 639px)');
    const update = () => setPhone(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!open) return;
    const panel = popup.current;
    if (!panel) return;
    returnTo.current = panel.ownerDocument.activeElement as HTMLElement | null;
    // Focus the existing selector first, including recovery opened from an empty result.
    (panelRef.current?.querySelector<HTMLElement>(focusable) ?? close.current)?.focus();
    return () => {
      const previous = returnTo.current;
      queueMicrotask(() => {
        if (panel.isConnected && !panel.hidden) return;
        const target = previous?.isConnected ? previous : trigger.current;
        if (target?.isConnected) target.focus();
      });
    };
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
      if (event.target instanceof Node && !wrapper.current?.contains(event.target)) onOpenChange(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        onOpenChange(false);
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, onOpenChange]);
  const streamLabel = stream === 'following' ? m.home_feed_following({}, options) : m.nav_home({}, options);
  const context = selections.length ? m.home_filter_context({ stream: streamLabel }, options) : streamLabel;
  return (
    <div ref={wrapper} className="relative min-w-0 flex-1 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          ref={trigger}
          type="button"
          variant="outline"
          className="min-h-11 whitespace-normal"
          aria-expanded={open}
          aria-controls={id}
          aria-haspopup="dialog"
          onClick={() => onOpenChange(!open)}
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
      <HomeFeedFilterSummary selections={selections} locale={locale} onClear={onClear} fallback={trigger} />
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
      {open && phone ? (
        <div
          data-home-filter-backdrop
          aria-hidden="true"
          className="fixed inset-0 z-40 bg-black/40"
          onClick={() => onOpenChange(false)}
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
          if (event.key !== 'Tab' || !popup.current) return;
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
              onClick={() => onOpenChange(false)}
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
          <HomeFeedFilterSummary selections={selections} locale={locale} onClear={onClear} fallback={close} />
        </div>
      </div>
    </div>
  );
}

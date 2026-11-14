import {
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { MapPinIcon } from 'lucide-react';
import * as D from '../shadcn/dropdown-menu.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../shadcn/popover.tsx';
import { BottomSheet } from './bottom-sheet.tsx';
import { Button } from '../shadcn/button.tsx';
import { Field, FieldLabel } from '../shadcn/field.tsx';
import { RadioGroup, RadioGroupItem } from '../shadcn/radio-group.tsx';

export type MenuEntry =
  | {
      type: 'item' | 'destructive';
      label: string;
      onSelect: () => void;
      disabled?: boolean;
      current?: boolean;
      keepOpen?: boolean;
    }
  | { type: 'link'; label: string; href: string; disabled?: boolean; current?: boolean }
  | { type: 'separator' }
  | { type: 'submenu'; label: string; entries: MenuEntry[] }
  | {
      type: 'radio';
      label: string;
      value: string;
      options: { label: string; value: string }[];
      onValueChange: (value: string) => void;
    };

export interface MenuProps {
  entries?: MenuEntry[] | undefined;
  content?: ReactNode;
  trigger: ReactElement;
  title: string;
  backLabel?: string;
  /** Close after a link or an explicitly admitted contextual selection. */
  closeOnNavigation?: boolean;
  /** Identity of the admitted navigation visit; replacement retires pending opener focus. */
  navigationScope?: object;
  children?: ReactNode;
  triggerSlot?: boolean;
}

const TriggerContext = createContext<ReactElement | null>(null);
const navigationSelection = 'rezics-menu-navigation-selection';

/** Signal an accepted selection through its physical host, including route-owned portals. */
export function dismissMenuForNavigation(host: HTMLElement | null) {
  if (!host) return false;
  const Event = host.ownerDocument.defaultView!.Event;
  return !host.dispatchEvent(new Event(navigationSelection, { bubbles: true, cancelable: true }));
}

export function MenuTriggerSlot() {
  return useContext(TriggerContext);
}

function isNavigationLink(
  event: Pick<globalThis.MouseEvent, 'target' | 'button' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
  return (
    anchor !== null &&
    !anchor.hasAttribute('download') &&
    !anchor.closest('[data-menu-navigation-selection]') &&
    (!anchor.getAttribute('target') || anchor.getAttribute('target') === '_self') &&
    anchor.getAttribute('aria-disabled') !== 'true'
  );
}

function legacyEntries(content: ReactNode): MenuEntry[] {
  const output: MenuEntry[] = [];
  for (const node of Array.isArray(content) ? content : [content]) {
    if (!isValidElement<Record<string, unknown>>(node)) continue;
    const name =
      (node.type as { displayName?: string; name?: string }).displayName ?? (node.type as { name?: string }).name ?? '';
    const props = node.props;
    if (name.includes('Separator')) {
      output.push({ type: 'separator' });
      continue;
    }
    if (name.includes('RadioGroup')) {
      const children = Array.isArray(props.children) ? props.children : [props.children];
      const options = children
        .filter(isValidElement<Record<string, unknown>>)
        .map((child) => ({ value: String(child.props.value ?? ''), label: String(child.props.children ?? '') }));
      output.push({
        type: 'radio',
        label: String(props['aria-label'] ?? ''),
        value: String(props.value ?? ''),
        options,
        onValueChange: props.onValueChange as (value: string) => void,
      });
      continue;
    }
    if (name.includes('RadioItem')) continue;
    if (name.includes('Item')) {
      output.push({
        type: props.variant === 'destructive' ? 'destructive' : 'item',
        label: String(props.children ?? ''),
        onSelect: (props.onClick as (() => void) | undefined) ?? (() => {}),
        ...(props.disabled ? { disabled: true } : {}),
      });
      continue;
    }
    output.push(...legacyEntries(props.children as ReactNode));
  }
  return output;
}

const entryPanelClassName = 'w-max min-w-[min(8rem,var(--available-width))] max-w-[min(24rem,var(--available-width))]';
const entryRowClassName = 'min-w-0 whitespace-normal text-start';
const touchEntryRowClassName = 'h-auto min-h-11 w-full min-w-0 justify-start gap-2 whitespace-normal py-2 text-start';

function EntryLabel({ label, current }: { label: string; current?: boolean }) {
  return (
    <>
      <span data-slot="menu-entry-label" className="min-w-0 flex-1 whitespace-normal [overflow-wrap:anywhere]">
        {label}
      </span>
      {current && (
        <MapPinIcon data-slot="menu-current-indicator" aria-hidden="true" className="ms-auto size-4 shrink-0" />
      )}
    </>
  );
}

function DropdownEntries({
  entries,
  select,
  close,
}: {
  entries: MenuEntry[];
  select: (entry: MenuEntry) => void;
  close: () => void;
}) {
  return entries.map((entry, index) => {
    if (entry.type === 'separator') return <D.DropdownMenuSeparator key={index} />;
    if (entry.type === 'radio')
      return (
        <D.DropdownMenuRadioGroup
          key={index}
          aria-label={entry.label}
          value={entry.value}
          onValueChange={(value) => {
            entry.onValueChange(value);
            close();
          }}
        >
          {entry.options.map((option) => (
            <D.DropdownMenuRadioItem key={option.value} value={option.value} className={entryRowClassName}>
              <EntryLabel label={option.label} />
            </D.DropdownMenuRadioItem>
          ))}
        </D.DropdownMenuRadioGroup>
      );
    if (entry.type === 'submenu')
      return (
        <D.DropdownMenuSub key={index}>
          <D.DropdownMenuSubTrigger className={entryRowClassName}>
            <EntryLabel label={entry.label} />
          </D.DropdownMenuSubTrigger>
          <D.DropdownMenuSubContent className={entryPanelClassName}>
            <DropdownEntries entries={entry.entries} select={select} close={close} />
          </D.DropdownMenuSubContent>
        </D.DropdownMenuSub>
      );
    if (entry.type === 'link')
      return (
        <D.DropdownMenuItem
          key={index}
          className={entryRowClassName}
          disabled={entry.disabled}
          render={<a href={entry.href} aria-current={entry.current ? 'page' : undefined} />}
        >
          <EntryLabel label={entry.label} current={entry.current} />
        </D.DropdownMenuItem>
      );
    return (
      <D.DropdownMenuItem
        key={index}
        className={entryRowClassName}
        disabled={entry.disabled}
        aria-current={entry.current ? 'page' : undefined}
        variant={entry.type === 'destructive' ? 'destructive' : 'default'}
        onClick={() => select(entry)}
      >
        <EntryLabel label={entry.label} current={entry.current} />
      </D.DropdownMenuItem>
    );
  });
}

export function Menu({
  entries: entryProps,
  content,
  trigger,
  title,
  backLabel,
  closeOnNavigation = false,
  navigationScope,
  children,
  triggerSlot = false,
}: MenuProps) {
  const entries = entryProps ?? legacyEntries(content);
  const resolvedBackLabel =
    backLabel ??
    (
      {
        de: 'Zurück',
        en: 'Back',
        es: 'Atrás',
        fr: 'Retour',
        ja: '戻る',
        ko: '뒤로',
        'zh-Hans': '返回',
        'zh-Hant': '返回',
      } as const
    )[
      typeof document === 'undefined'
        ? 'en'
        : (document.documentElement.lang as 'de' | 'en' | 'es' | 'fr' | 'ja' | 'ko' | 'zh-Hans' | 'zh-Hant')
    ] ??
    'Back';
  const [form, setForm] = useState<'sheet' | 'dropdown' | null>(null);
  const [open, setOpen] = useState(false);
  const [stack, setStack] = useState<{ label: string; entries: MenuEntry[] }[]>([]);
  const radioName = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const historyDepth = useRef(0);
  const formRef = useRef(form);
  const openingRef = useRef(false);
  const openRef = useRef(false);
  const navigationDismissed = useRef(false);
  const returnFocus = useRef<number | null>(null);
  const cancelReturnFocus = () => {
    if (returnFocus.current !== null) cancelAnimationFrame(returnFocus.current);
    returnFocus.current = null;
  };
  // Replacing the caller's visit must also retire a queued return to its opener.
  useLayoutEffect(() => cancelReturnFocus, [navigationScope, closeOnNavigation ? content : undefined]);
  formRef.current = form;
  const page = stack.at(-1);
  const customContent = content !== undefined;
  const openMenu = () => {
    cancelReturnFocus();
    navigationDismissed.current = false;
    openRef.current = true;
    const sheet = window.matchMedia('(max-width: 767px)').matches || window.matchMedia('(pointer: coarse)').matches;
    const next = sheet ? 'sheet' : 'dropdown';
    openingRef.current = true;
    formRef.current = next;
    setForm(next);
    setOpen(true);
    if (sheet && historyDepth.current === 0 && !closeOnNavigation) {
      window.history.pushState({ rezicsMenu: true }, '', window.location.href);
      historyDepth.current = 1;
    }
  };
  const close = (fromHistory = false, restoreFocus = true) => {
    // A sheet's opening tap can dismiss through the same pointer as it opens.
    if (openingRef.current && formRef.current === 'sheet') return;
    openingRef.current = false;
    openRef.current = false;
    cancelReturnFocus();
    setOpen(false);
    setStack([]);
    if (historyDepth.current && !fromHistory) window.history.go(-historyDepth.current);
    historyDepth.current = 0;
    if (restoreFocus && !navigationDismissed.current) {
      const opener = triggerRef.current;
      const owner = document.activeElement;
      returnFocus.current = requestAnimationFrame(() => {
        returnFocus.current = null;
        const active = document.activeElement;
        if (
          !openRef.current &&
          opener?.isConnected &&
          triggerRef.current === opener &&
          (active === owner || active === document.body)
        )
          opener.focus();
      });
    }
  };
  const dismissNavigation = () => {
    if (!closeOnNavigation || !openRef.current) return false;
    navigationDismissed.current = true;
    openingRef.current = false;
    close(false, false);
    return true;
  };
  const dismissRef = useRef(dismissNavigation);
  dismissRef.current = dismissNavigation;
  const physicalNavigationHost = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const selection = (event: Event) => {
      // A retired route/reader can invalidate an already closed Menu's queued return.
      cancelReturnFocus();
      if (dismissRef.current()) event.preventDefault();
    };
    const link = (event: globalThis.MouseEvent) => {
      if (isNavigationLink(event)) dismissRef.current();
    };
    node.addEventListener(navigationSelection, selection);
    node.addEventListener('click', link, true);
    return () => {
      node.removeEventListener(navigationSelection, selection);
      node.removeEventListener('click', link, true);
    };
  }, []);
  const ignoreOpeningDismiss = (reason: string | undefined) =>
    openingRef.current && (reason === 'outside-press' || reason === 'trigger-press');
  useEffect(() => {
    if (!open) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        openingRef.current = false;
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [open, form]);
  useEffect(() => {
    const back = () => {
      if (!open || form !== 'sheet') return;
      historyDepth.current = Math.max(0, historyDepth.current - 1);
      if (stack.length) {
        setStack((value) => value.slice(0, -1));
      } else close(true);
    };
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, [open, form, stack]);
  const select = (entry: MenuEntry) => {
    if (entry.type === 'item' || entry.type === 'destructive') {
      if (!entry.keepOpen) close();
      entry.onSelect();
    }
    if (entry.type === 'link') close();
  };
  const closeAfterNavigation = (
    event: Pick<globalThis.MouseEvent, 'target' | 'button' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  ) => {
    if (isNavigationLink(event)) dismissNavigation();
  };
  const triggerNode = (
    <span
      ref={(node) => {
        triggerRef.current = node?.querySelector('button, [role=button]') ?? node;
      }}
      onClick={openMenu}
    >
      {trigger}
    </span>
  );
  const slot = triggerSlot ? (
    form === 'dropdown' ? (
      <D.DropdownMenu
        open={open}
        onOpenChange={(value) => {
          if (value) openMenu();
          else if (formRef.current === 'dropdown') close();
        }}
      >
        <D.DropdownMenuTrigger
          render={trigger}
          onClick={(event) => {
            triggerRef.current = event.currentTarget as HTMLElement;
          }}
        />
        <D.DropdownMenuContent className={entryPanelClassName}>
          <DropdownEntries entries={entries} select={select} close={() => close()} />
        </D.DropdownMenuContent>
      </D.DropdownMenu>
    ) : (
      triggerNode
    )
  ) : null;
  return (
    <TriggerContext.Provider value={slot}>
      {children}
      {!triggerSlot &&
        (customContent ? (
          <Popover
            open={open && form === 'dropdown'}
            onOpenChange={(value, details) => {
              if (value) {
                openMenu();
                return;
              }
              if (ignoreOpeningDismiss(details.reason)) return;
              const target = details.event.target;
              if (details.reason === 'outside-press' && target instanceof Element && target.closest('nav a[href]')) {
                details.cancel();
                return;
              }
              if (details.reason === 'outside-press') close(false, false);
              else close();
            }}
          >
            <PopoverTrigger
              render={trigger}
              onClick={(event) => {
                triggerRef.current = event.currentTarget as HTMLElement;
              }}
            />
            <PopoverContent
              ref={physicalNavigationHost}
              side="bottom"
              align="start"
              sideOffset={4}
              role="dialog"
              aria-label={title}
              initialFocus
              finalFocus={false}
              onClickCapture={closeAfterNavigation}
              className="max-h-[var(--available-height)] w-max min-w-[min(16rem,var(--available-width))] max-w-[min(32rem,var(--available-width))] overflow-x-hidden overflow-y-auto overscroll-contain rounded-2xl gap-1 p-2 text-popover-foreground ring-1 ring-foreground/5 dark:ring-foreground/10"
            >
              {content}
            </PopoverContent>
          </Popover>
        ) : form === 'sheet' ? (
          triggerNode
        ) : (
          <D.DropdownMenu
            open={open && form === 'dropdown'}
            onOpenChange={(value) => {
              if (value) openMenu();
              else if (formRef.current === 'dropdown') close();
            }}
          >
            <D.DropdownMenuTrigger
              render={trigger}
              onClick={(event) => {
                triggerRef.current = event.currentTarget as HTMLElement;
              }}
            />
            {form === 'dropdown' && (
              <D.DropdownMenuContent
                className={entryPanelClassName}
                ref={physicalNavigationHost}
                finalFocus={false}
                onClickCapture={closeAfterNavigation}
              >
                {content ?? <DropdownEntries entries={entries} select={select} close={() => close()} />}
              </D.DropdownMenuContent>
            )}
          </D.DropdownMenu>
        ))}
      {form === 'sheet' && (
        <BottomSheet
          finalFocus={false}
          open={open}
          onOpenChange={(value) => {
            if (value) openMenu();
            else close();
          }}
          title={page?.label ?? title}
          before={
            page ? (
              <Button variant="ghost" className="min-h-11" onClick={() => window.history.back()}>
                ‹ {resolvedBackLabel}
              </Button>
            ) : undefined
          }
        >
          <div
            ref={physicalNavigationHost}
            className="mt-2 flex min-w-0 max-w-full flex-col"
            onClickCapture={closeAfterNavigation}
          >
            {content && entries.length === 0 && !page
              ? content
              : (page?.entries ?? entries).map((entry, index) => {
                  if (entry.type === 'separator') return <hr key={index} className="my-2 border-border" />;
                  if (entry.type === 'radio')
                    return (
                      <RadioGroup
                        key={index}
                        aria-label={entry.label}
                        value={entry.value}
                        onValueChange={(value) => {
                          entry.onValueChange(value);
                          close();
                        }}
                        className="min-w-0 gap-0"
                      >
                        {entry.options.map((option) => (
                          <Field key={option.value} orientation="horizontal" className="min-h-11 min-w-0 items-center">
                            <RadioGroupItem
                              id={`${radioName}-${index}-${option.value}`}
                              value={option.value}
                              className="shrink-0"
                            />
                            <FieldLabel
                              htmlFor={`${radioName}-${index}-${option.value}`}
                              className="min-h-11 min-w-0 flex-1 items-center rounded-xl px-3 py-2 text-start hover:bg-accent"
                            >
                              <EntryLabel label={option.label} />
                            </FieldLabel>
                          </Field>
                        ))}
                      </RadioGroup>
                    );
                  if (entry.type === 'submenu')
                    return (
                      <Button
                        key={index}
                        variant="ghost"
                        className={touchEntryRowClassName}
                        onClick={() => {
                          setStack((value) => [...value, entry]);
                          window.history.pushState({ rezicsMenuPage: true }, '', window.location.href);
                          historyDepth.current += 1;
                        }}
                      >
                        <EntryLabel label={entry.label} />
                        <span aria-hidden className="shrink-0">
                          ›
                        </span>
                      </Button>
                    );
                  if (entry.type === 'link')
                    return (
                      <a
                        key={index}
                        href={entry.href}
                        aria-current={entry.current ? 'page' : undefined}
                        className={`flex items-center rounded-xl px-3 text-sm hover:bg-accent ${touchEntryRowClassName}`}
                        onClick={() => close()}
                      >
                        <EntryLabel label={entry.label} current={entry.current} />
                      </a>
                    );
                  return (
                    <Button
                      key={index}
                      variant="ghost"
                      className={`${touchEntryRowClassName} ${entry.type === 'destructive' ? 'text-destructive hover:text-destructive' : ''}`}
                      disabled={entry.disabled}
                      aria-current={entry.current ? 'page' : undefined}
                      onClick={() => select(entry)}
                    >
                      <EntryLabel label={entry.label} current={entry.current} />
                    </Button>
                  );
                })}
          </div>
        </BottomSheet>
      )}
    </TriggerContext.Provider>
  );
}

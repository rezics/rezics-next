import {
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type MouseEvent,
  type ReactNode,
} from 'react';
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
  /** Close after an in-app link is followed from custom menu content. */
  closeOnNavigation?: boolean;
  children?: ReactNode;
  triggerSlot?: boolean;
}

const TriggerContext = createContext<ReactElement | null>(null);
export function MenuTriggerSlot() {
  return useContext(TriggerContext);
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
            <D.DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </D.DropdownMenuRadioItem>
          ))}
        </D.DropdownMenuRadioGroup>
      );
    if (entry.type === 'submenu')
      return (
        <D.DropdownMenuSub key={index}>
          <D.DropdownMenuSubTrigger>{entry.label}</D.DropdownMenuSubTrigger>
          <D.DropdownMenuSubContent>
            <DropdownEntries entries={entry.entries} select={select} close={close} />
          </D.DropdownMenuSubContent>
        </D.DropdownMenuSub>
      );
    if (entry.type === 'link')
      return (
        <D.DropdownMenuItem
          key={index}
          disabled={entry.disabled}
          render={<a href={entry.href} aria-current={entry.current ? 'page' : undefined} />}
        >
          {entry.label}
        </D.DropdownMenuItem>
      );
    return (
      <D.DropdownMenuItem
        key={index}
        disabled={entry.disabled}
        aria-current={entry.current ? 'page' : undefined}
        variant={entry.type === 'destructive' ? 'destructive' : 'default'}
        onClick={() => select(entry)}
      >
        {entry.label}
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
  formRef.current = form;
  const page = stack.at(-1);
  const customContent = content !== undefined;
  const openMenu = () => {
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
    setOpen(false);
    setStack([]);
    if (historyDepth.current && !fromHistory) window.history.go(-historyDepth.current);
    historyDepth.current = 0;
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };
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
  const closeAfterNavigation = (event: MouseEvent<HTMLElement>) => {
    if (closeOnNavigation && event.target instanceof Element && event.target.closest('a')) close();
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
        <D.DropdownMenuContent>
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
              <D.DropdownMenuContent onClickCapture={closeAfterNavigation}>
                {content ?? <DropdownEntries entries={entries} select={select} close={() => close()} />}
              </D.DropdownMenuContent>
            )}
          </D.DropdownMenu>
        ))}
      {form === 'sheet' && (
        <BottomSheet
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
          <div className="mt-2 flex min-w-0 max-w-full flex-col" onClickCapture={closeAfterNavigation}>
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
                        className="gap-0"
                      >
                        {entry.options.map((option) => (
                          <Field key={option.value} orientation="horizontal" className="min-h-11 items-center">
                            <RadioGroupItem id={`${radioName}-${index}-${option.value}`} value={option.value} />
                            <FieldLabel
                              htmlFor={`${radioName}-${index}-${option.value}`}
                              className="min-h-11 flex-1 items-center rounded-xl px-3 hover:bg-accent"
                            >
                              {option.label}
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
                        className="min-h-11 justify-between"
                        onClick={() => {
                          setStack((value) => [...value, entry]);
                          window.history.pushState({ rezicsMenuPage: true }, '', window.location.href);
                          historyDepth.current += 1;
                        }}
                      >
                        {entry.label}
                        <span aria-hidden>›</span>
                      </Button>
                    );
                  if (entry.type === 'link')
                    return (
                      <a
                        key={index}
                        href={entry.href}
                        aria-current={entry.current ? 'page' : undefined}
                        className="flex min-h-11 items-center rounded-xl px-3 text-sm hover:bg-accent"
                        onClick={() => close()}
                      >
                        {entry.label}
                      </a>
                    );
                  return (
                    <Button
                      key={index}
                      variant="ghost"
                      className={`min-h-11 justify-start ${entry.type === 'destructive' ? 'text-destructive hover:text-destructive' : ''}`}
                      disabled={entry.disabled}
                      aria-current={entry.current ? 'page' : undefined}
                      onClick={() => select(entry)}
                    >
                      {entry.label}
                    </Button>
                  );
                })}
          </div>
        </BottomSheet>
      )}
    </TriggerContext.Provider>
  );
}

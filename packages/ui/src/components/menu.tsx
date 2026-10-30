import {
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import * as D from '../shadcn/dropdown-menu.tsx';
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
      keepOpen?: boolean;
    }
  | { type: 'link'; label: string; href: string; disabled?: boolean }
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
        <D.DropdownMenuItem key={index} disabled={entry.disabled} render={<a href={entry.href} />}>
          {entry.label}
        </D.DropdownMenuItem>
      );
    return (
      <D.DropdownMenuItem
        key={index}
        disabled={entry.disabled}
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
  const [customContentPosition, setCustomContentPosition] = useState<{ top: number; left: number; width: number }>();
  const radioName = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const customContentRef = useRef<HTMLDivElement | null>(null);
  const historyDepth = useRef(0);
  const page = stack.at(-1);
  const customContent = content !== undefined;
  const openMenu = (event?: { preventDefault?: () => void }) => {
    event?.preventDefault?.();
    const sheet = window.matchMedia('(max-width: 767px)').matches || window.matchMedia('(pointer: coarse)').matches;
    setForm(sheet ? 'sheet' : 'dropdown');
    setOpen(true);
    if (sheet && historyDepth.current === 0 && !closeOnNavigation) {
      window.history.pushState({ rezicsMenu: true }, '', window.location.href);
      historyDepth.current = 1;
    }
  };
  const close = (fromHistory = false, restoreFocus = true) => {
    setOpen(false);
    setStack([]);
    if (historyDepth.current && !fromHistory) window.history.go(-historyDepth.current);
    historyDepth.current = 0;
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };
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
  useEffect(() => {
    if (!customContent || !open || form !== 'dropdown') return;
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target;
      const primaryNavigationLink = target instanceof Element && target.closest('nav a[href]') !== null;
      if (
        target instanceof Node &&
        !customContentRef.current?.contains(target) &&
        !triggerRef.current?.contains(target) &&
        !primaryNavigationLink
      )
        close(false, false);
    };
    const dismissWithEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('keydown', dismissWithEscape, true);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('keydown', dismissWithEscape, true);
    };
  }, [customContent, form, open]);
  useLayoutEffect(() => {
    if (!customContent || !open || form !== 'dropdown' || !customContentPosition) return;
    customContentRef.current
      ?.querySelector<HTMLElement>(
        '[autofocus], a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      ?.focus();
  }, [customContent, customContentPosition, form, open]);
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
  const customContentTrigger = (
    <span
      ref={(node) => {
        const control = node?.querySelector<HTMLElement>('button, [role=button]') ?? node;
        triggerRef.current = control;
        control?.setAttribute('aria-haspopup', 'dialog');
        control?.setAttribute('aria-expanded', String(open && form === 'dropdown'));
      }}
      onClick={(event) => {
        if (open && form === 'dropdown') {
          close();
          return;
        }
        const button = triggerRef.current;
        if (button) {
          const rect = button.getBoundingClientRect();
          const width = Math.max(rect.width, 128);
          setCustomContentPosition({
            top: rect.bottom + 4,
            left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
            width,
          });
        }
        openMenu(event);
      }}
    >
      {trigger}
    </span>
  );
  const slot = triggerSlot ? (
    form === 'dropdown' ? (
      <D.DropdownMenu open={open} onOpenChange={(value) => (value ? openMenu() : close())}>
        <D.DropdownMenuTrigger
          render={trigger}
          onClick={(event) => {
            triggerRef.current = event.currentTarget as HTMLElement;
            openMenu(event);
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
          <>
            {customContentTrigger}
            {open && form === 'dropdown' && customContentPosition
              ? createPortal(
                  <div
                    ref={customContentRef}
                    role="dialog"
                    aria-label={title}
                    className="fixed z-50 grid gap-1 rounded-2xl bg-popover p-2 text-popover-foreground shadow-lg ring-1 ring-foreground/5 dark:ring-foreground/10"
                    onClickCapture={closeAfterNavigation}
                    style={{
                      top: customContentPosition.top,
                      left: customContentPosition.left,
                      width: customContentPosition.width,
                    }}
                  >
                    {content}
                  </div>,
                  document.body,
                )
              : null}
          </>
        ) : (
          <D.DropdownMenu open={open && form === 'dropdown'} onOpenChange={(value) => (value ? openMenu() : close())}>
            <D.DropdownMenuTrigger
              render={trigger}
              onClick={(event) => {
                triggerRef.current = event.currentTarget as HTMLElement;
                openMenu(event);
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
          onOpenChange={(value) => (value ? openMenu() : close())}
          title={page?.label ?? title}
          before={
            page ? (
              <Button variant="ghost" className="min-h-11" onClick={() => window.history.back()}>
                ‹ {resolvedBackLabel}
              </Button>
            ) : undefined
          }
        >
          <div className="mt-2 flex flex-col" onClickCapture={closeAfterNavigation}>
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

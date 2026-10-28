import {
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import * as D from '../shadcn/dropdown-menu.tsx';
import { Drawer, DrawerContent, DrawerTitle } from '../shadcn/drawer.tsx';
import { Button } from '../shadcn/button.tsx';

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
  entries?: MenuEntry[];
  content?: ReactNode;
  trigger: ReactElement;
  title: string;
  backLabel?: string;
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
  const page = stack.at(-1);
  const openMenu = (event?: { preventDefault?: () => void }) => {
    event?.preventDefault?.();
    const sheet = window.matchMedia('(max-width: 767px)').matches || window.matchMedia('(pointer: coarse)').matches;
    setForm(sheet ? 'sheet' : 'dropdown');
    setOpen(true);
    if (sheet && historyDepth.current === 0) {
      window.history.pushState({ rezicsMenu: true }, '', window.location.href);
      historyDepth.current = 1;
    }
  };
  const close = (fromHistory = false) => {
    setOpen(false);
    setStack([]);
    if (historyDepth.current && !fromHistory) window.history.go(-historyDepth.current);
    historyDepth.current = 0;
    requestAnimationFrame(() => triggerRef.current?.focus());
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
  const select = (entry: MenuEntry) => {
    if (entry.type === 'item' || entry.type === 'destructive') {
      if (!entry.keepOpen) close();
      entry.onSelect();
    }
    if (entry.type === 'link') close();
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
      {!triggerSlot && (
        <D.DropdownMenu open={open && form === 'dropdown'} onOpenChange={(value) => (value ? openMenu() : close())}>
          <D.DropdownMenuTrigger
            render={trigger}
            onClick={(event) => {
              triggerRef.current = event.currentTarget as HTMLElement;
              openMenu(event);
            }}
          />
          {form === 'dropdown' && (
            <D.DropdownMenuContent>
              {content ?? <DropdownEntries entries={entries} select={select} close={() => close()} />}
            </D.DropdownMenuContent>
          )}
        </D.DropdownMenu>
      )}
      {form === 'sheet' && (
        <Drawer open={open} onOpenChange={(value) => (value ? openMenu() : close())}>
          <DrawerContent>
            <div className="max-h-[80dvh] overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
              <DrawerTitle>{page?.label ?? title}</DrawerTitle>
              {page && (
                <Button variant="ghost" className="min-h-11" onClick={() => window.history.back()}>
                  ‹ {resolvedBackLabel}
                </Button>
              )}
              <div className="mt-2 flex flex-col">
                {content && entries.length === 0 && !page
                  ? content
                  : (page?.entries ?? entries).map((entry, index) => {
                      if (entry.type === 'separator') return <hr key={index} className="my-2 border-border" />;
                      if (entry.type === 'radio')
                        return (
                          <div key={index} role="radiogroup" aria-label={entry.label}>
                            {entry.options.map((option) => (
                              <label
                                key={option.value}
                                className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 hover:bg-accent"
                              >
                                <input
                                  type="radio"
                                  name={`${radioName}-${index}`}
                                  checked={entry.value === option.value}
                                  onChange={() => {
                                    entry.onValueChange(option.value);
                                    close();
                                  }}
                                />
                                {option.label}
                              </label>
                            ))}
                          </div>
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
            </div>
          </DrawerContent>
        </Drawer>
      )}
    </TriggerContext.Provider>
  );
}

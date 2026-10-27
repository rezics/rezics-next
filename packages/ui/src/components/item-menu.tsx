import { createContext, useContext, useEffect, useId, useState, type ReactElement, type ReactNode } from 'react';
import * as D from '../shadcn/dropdown-menu.tsx';
import * as C from '../shadcn/context-menu.tsx';
import { Drawer, DrawerContent, DrawerTitle } from '../shadcn/drawer.tsx';
import { Button } from '../shadcn/button.tsx';

export type ItemMenuEntry =
  | { type: 'item'; label: string; onSelect: () => void; disabled?: boolean }
  | { type: 'separator' }
  | { type: 'submenu'; label: string; entries: ItemMenuEntry[] }
  | {
      type: 'radio';
      label: string;
      value: string;
      options: { label: string; value: string }[];
      onValueChange: (value: string) => void;
    };
export interface ItemMenuProps {
  entries: ItemMenuEntry[];
  trigger: ReactElement;
  children: ReactNode;
  title: string;
  backLabel: string;
  /** Render the trigger at a caller-provided slot within the menu's child. */
  triggerSlot?: boolean;
}

const ItemMenuTriggerContext = createContext<ReactElement | null>(null);

/** Place the enclosing ItemMenu trigger inside a card's state row. */
export function ItemMenuTriggerSlot() {
  return useContext(ItemMenuTriggerContext);
}

function DropdownEntries({ entries }: { entries: ItemMenuEntry[] }) {
  return entries.map((entry, index) => {
    switch (entry.type) {
      case 'separator':
        return <D.DropdownMenuSeparator key={index} />;
      case 'item':
        return (
          <D.DropdownMenuItem key={index} disabled={entry.disabled} onClick={entry.onSelect}>
            {entry.label}
          </D.DropdownMenuItem>
        );
      case 'submenu':
        return (
          <D.DropdownMenuSub key={index}>
            <D.DropdownMenuSubTrigger>{entry.label}</D.DropdownMenuSubTrigger>
            <D.DropdownMenuSubContent>
              <DropdownEntries entries={entry.entries} />
            </D.DropdownMenuSubContent>
          </D.DropdownMenuSub>
        );
      case 'radio':
        return (
          <D.DropdownMenuRadioGroup
            key={index}
            aria-label={entry.label}
            value={entry.value}
            onValueChange={entry.onValueChange}
          >
            {entry.options.map((option) => (
              <D.DropdownMenuRadioItem key={option.value} value={option.value}>
                {option.label}
              </D.DropdownMenuRadioItem>
            ))}
          </D.DropdownMenuRadioGroup>
        );
    }
  });
}
function ContextEntries({ entries }: { entries: ItemMenuEntry[] }) {
  return entries.map((entry, index) => {
    switch (entry.type) {
      case 'separator':
        return <C.ContextMenuSeparator key={index} />;
      case 'item':
        return (
          <C.ContextMenuItem key={index} disabled={entry.disabled} onClick={entry.onSelect}>
            {entry.label}
          </C.ContextMenuItem>
        );
      case 'submenu':
        return (
          <C.ContextMenuSub key={index}>
            <C.ContextMenuSubTrigger>{entry.label}</C.ContextMenuSubTrigger>
            <C.ContextMenuSubContent>
              <ContextEntries entries={entry.entries} />
            </C.ContextMenuSubContent>
          </C.ContextMenuSub>
        );
      case 'radio':
        return (
          <C.ContextMenuRadioGroup
            key={index}
            aria-label={entry.label}
            value={entry.value}
            onValueChange={entry.onValueChange}
          >
            {entry.options.map((option) => (
              <C.ContextMenuRadioItem key={option.value} value={option.value}>
                {option.label}
              </C.ContextMenuRadioItem>
            ))}
          </C.ContextMenuRadioGroup>
        );
    }
  });
}
export function ItemMenu({ entries, trigger, children, title, backLabel, triggerSlot = false }: ItemMenuProps) {
  const radioName = useId();
  const [small, setSmall] = useState(false);
  const [fine, setFine] = useState(false);
  const [open, setOpen] = useState(false);
  const [stack, setStack] = useState<{ label: string; entries: ItemMenuEntry[] }[]>([]);
  useEffect(() => {
    const size = window.matchMedia('(max-width: 639px)');
    const pointer = window.matchMedia('(pointer: fine)');
    const update = () => {
      setSmall(size.matches);
      setFine(pointer.matches);
    };
    update();
    size.addEventListener('change', update);
    pointer.addEventListener('change', update);
    return () => {
      size.removeEventListener('change', update);
      pointer.removeEventListener('change', update);
    };
  }, []);
  const changeOpen = (value: boolean) => {
    setOpen(value);
    if (!value) setStack([]);
  };
  if (small) {
    const page = stack.at(-1);
    const triggerNode = <span onClick={() => changeOpen(true)}>{trigger}</span>;
    return (
      <ItemMenuTriggerContext.Provider value={triggerSlot ? triggerNode : null}>
        <span
          onContextMenu={(event) => {
            if (fine) {
              event.preventDefault();
              changeOpen(true);
            }
          }}
        >
          {children}
        </span>
        {!triggerSlot && triggerNode}
        <Drawer open={open} onOpenChange={changeOpen}>
          <DrawerContent>
            <div className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
              <DrawerTitle>{page?.label ?? title}</DrawerTitle>
              {page && (
                <Button variant="ghost" onClick={() => setStack(stack.slice(0, -1))}>
                  {backLabel}
                </Button>
              )}
              <div className="mt-2 flex flex-col">
                {(page?.entries ?? entries).map((entry, index) => {
                  if (entry.type === 'separator') return <hr key={index} className="my-2 border-border" />;
                  if (entry.type === 'item')
                    return (
                      <Button
                        key={index}
                        variant="ghost"
                        className="justify-start"
                        disabled={entry.disabled}
                        onClick={() => {
                          changeOpen(false);
                          entry.onSelect();
                        }}
                      >
                        {entry.label}
                      </Button>
                    );
                  if (entry.type === 'submenu')
                    return (
                      <Button
                        key={index}
                        variant="ghost"
                        className="justify-between"
                        onClick={() => setStack([...stack, entry])}
                      >
                        {entry.label}
                        <span aria-hidden>›</span>
                      </Button>
                    );
                  return (
                    <div key={index} role="radiogroup" aria-label={entry.label}>
                      {entry.options.map((option) => (
                        <label
                          key={option.value}
                          className="flex min-h-10 w-full items-center gap-3 rounded-xl px-3 hover:bg-accent"
                        >
                          <input
                            type="radio"
                            name={`${radioName}-${index}`}
                            checked={entry.value === option.value}
                            onChange={() => {
                              entry.onValueChange(option.value);
                            }}
                          />
                          {option.label}
                        </label>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          </DrawerContent>
        </Drawer>
      </ItemMenuTriggerContext.Provider>
    );
  }
  const area = fine ? (
    <C.ContextMenu>
      <C.ContextMenuTrigger render={<span />}>{children}</C.ContextMenuTrigger>
      <C.ContextMenuContent>
        <ContextEntries entries={entries} />
      </C.ContextMenuContent>
    </C.ContextMenu>
  ) : (
    children
  );
  const triggerNode = (
    <D.DropdownMenu>
      <D.DropdownMenuTrigger render={trigger} />
      <D.DropdownMenuContent>
        <DropdownEntries entries={entries} />
      </D.DropdownMenuContent>
    </D.DropdownMenu>
  );
  return (
    <ItemMenuTriggerContext.Provider value={triggerSlot ? triggerNode : null}>
      {area}
      {!triggerSlot && triggerNode}
    </ItemMenuTriggerContext.Provider>
  );
}

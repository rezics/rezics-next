'use client';

import { ResponsiveDialog } from '@rezics/ui/responsive-dialog';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@rezics/ui/shadcn/command';
import type { EditorWorkbenchLabels } from './editor-workbench-labels.ts';
import { useLayoutEffect, useRef } from 'react';
import { observeCommandActiveDescendants } from './editor-command-aria.ts';

export type EditorProductCommand = {
  id: string;
  label: string;
  keywords?: readonly string[];
  disabled?: boolean;
  active?: boolean;
  shortcut?: string;
  run: () => boolean | void;
};

export function EditorCommandPalette({
  open,
  onClose,
  commands,
  labels,
  isCurrent,
  finalFocus,
}: {
  open: boolean;
  onClose: () => void;
  commands: readonly EditorProductCommand[];
  labels: EditorWorkbenchLabels;
  isCurrent: () => boolean;
  finalFocus: () => HTMLElement | false;
}) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => (root.current ? observeCommandActiveDescendants(root.current) : undefined), [open]);
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={labels.commandPalette}
      description={labels.commandSearch}
      closeLabel={labels.close}
      finalFocus={finalFocus}
    >
      <Command ref={root} className="min-w-0" label={labels.commandSearch}>
        <CommandInput aria-label={labels.commandSearch} placeholder={labels.commandSearch} />
        <CommandList className="min-w-0">
          <CommandEmpty className="min-w-0 break-words px-3">{labels.noCommands}</CommandEmpty>
          <CommandGroup>
            {commands.map((command) => (
              <CommandItem
                key={command.id}
                value={command.id}
                keywords={[command.label, ...(command.keywords ?? [])]}
                disabled={!!command.disabled}
                className="min-h-11 gap-3 whitespace-normal text-start"
                onSelect={() => {
                  if (!isCurrent() || command.disabled) return;
                  onClose();
                  command.run();
                }}
              >
                <span className="min-w-0 flex-1 break-words">{command.label}</span>
                {command.shortcut ? (
                  <CommandShortcut className="shrink-0 self-center whitespace-nowrap ps-2">
                    {command.shortcut}
                  </CommandShortcut>
                ) : null}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </ResponsiveDialog>
  );
}

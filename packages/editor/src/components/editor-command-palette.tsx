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
      <Command label={labels.commandSearch}>
        <CommandInput aria-label={labels.commandSearch} placeholder={labels.commandSearch} />
        <CommandList>
          <CommandEmpty>{labels.noCommands}</CommandEmpty>
          <CommandGroup>
            {commands.map((command) => (
              <CommandItem
                key={command.id}
                value={command.id}
                keywords={[command.label, ...(command.keywords ?? [])]}
                disabled={!!command.disabled}
                onSelect={() => {
                  if (!isCurrent() || command.disabled) return;
                  onClose();
                  command.run();
                }}
              >
                {command.label}
                {command.shortcut ? <CommandShortcut>{command.shortcut}</CommandShortcut> : null}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </ResponsiveDialog>
  );
}

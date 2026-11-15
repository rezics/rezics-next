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

const shortcutKeyLabels: Record<string, string> = { Ctrl: 'Ctrl', Alt: 'Alt', Meta: 'Meta', Shift: 'Shift' };

function shortcutLabel(chord: string): string {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const keys = mac ? { Ctrl: '⌃', Alt: '⌥', Meta: '⌘', Shift: '⇧', Mod: '⌘' } : { ...shortcutKeyLabels, Mod: 'Ctrl' };
  const labels: Record<string, string> = keys;
  return chord
    .split('-')
    .map((key) => labels[key] ?? (key.length === 1 ? key.toUpperCase() : key))
    .join(mac ? '' : '+');
}

export type EditorProductCommand = {
  id: string;
  label: string;
  keywords?: readonly string[];
  disabled?: boolean;
  active?: boolean;
  shortcut?: string;
  afterPaletteClose?: boolean;
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
  const deferred = useRef<EditorProductCommand | null>(null);
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
      finalFocus={() => (deferred.current ? false : finalFocus())}
      onOpenChangeComplete={(next) => {
        if (next) return;
        const command = deferred.current;
        deferred.current = null;
        if (command && isCurrent()) command.run();
      }}
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
                className="whitespace-normal text-start"
                onSelect={() => {
                  if (!isCurrent() || command.disabled) return;
                  if (command.afterPaletteClose) {
                    deferred.current = command;
                    onClose();
                  } else if (command.run() !== false) onClose();
                }}
              >
                <span className="min-w-0 flex-1 break-words">{command.label}</span>
                {command.shortcut ? (
                  <CommandShortcut className="shrink-0 self-center whitespace-nowrap ps-2">
                    {shortcutLabel(command.shortcut)}
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

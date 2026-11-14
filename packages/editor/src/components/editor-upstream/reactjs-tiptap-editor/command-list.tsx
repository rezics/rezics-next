'use client';

// Adapted from SlashCommandNodeView.tsx and renderCommandListDefault.ts at the revision in README.md (MIT).
import { CommandGroup, CommandItem } from '@rezics/ui/shadcn/command';
import {
  Code2,
  Heading1,
  Heading2,
  Heading3,
  ImageUp,
  Link,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Pilcrow,
  Table,
  TextQuote,
} from 'lucide-react';
import type { EditorCommand } from '../../editor-commands.ts';
import { editorCommandLabel, type RichTextEditorLabels } from '../../editor-labels.ts';
import { productControlLabels } from './control-labels.ts';

const icons = {
  paragraph: Pilcrow,
  heading1: Heading1,
  heading2: Heading2,
  heading3: Heading3,
  bulletList: List,
  orderedList: ListOrdered,
  taskList: ListTodo,
  blockquote: TextQuote,
  codeBlock: Code2,
  image: ImageUp,
  table: Table,
  horizontalRule: Minus,
  link: Link,
};
const insertIds = new Set(['image', 'table', 'horizontalRule', 'link']);

/** Keep the product's format/insert groups; the caller supplies only schema-admitted commands. */
export function commandGroups(commands: readonly EditorCommand[]) {
  return [
    { name: 'blockFormat' as const, commands: commands.filter((command) => !insertIds.has(command.id)) },
    { name: 'blockInsert' as const, commands: commands.filter((command) => insertIds.has(command.id)) },
  ].filter((group) => group.commands.length > 0);
}

/** Labels and aliases are filtered within each upstream group, without a shared command store. */
export function filterCommandGroups(commands: readonly EditorCommand[], labels: RichTextEditorLabels, query: string) {
  const needle = query.toLowerCase().trim();
  return commandGroups(commands)
    .map((group) => ({
      ...group,
      commands: group.commands.filter((command) =>
        [editorCommandLabel(labels, command.label), ...(command.keywords ?? [])].some((word) =>
          word.toLowerCase().includes(needle),
        ),
      ),
    }))
    .filter((group) => group.commands.length > 0);
}

export function CommandListItems({
  commands,
  labels,
  selectedBlock,
  onSelect,
}: {
  commands: readonly EditorCommand[];
  labels: RichTextEditorLabels;
  selectedBlock?: string | undefined;
  onSelect: (command: EditorCommand) => void;
}) {
  return commandGroups(commands).map((group) => (
    <CommandGroup key={group.name} heading={labels[group.name] ?? productControlLabels[group.name]}>
      {group.commands.map((command) => {
        const Icon = icons[command.id as keyof typeof icons];
        return (
          <CommandItem
            key={command.id}
            value={command.id}
            data-checked={command.id === selectedBlock}
            className="min-h-11 gap-3 whitespace-normal text-start"
            onSelect={() => onSelect(command)}
          >
            {Icon ? <Icon aria-hidden="true" /> : null}
            <span className="min-w-0 flex-1 break-words">{editorCommandLabel(labels, command.label)}</span>
          </CommandItem>
        );
      })}
    </CommandGroup>
  ));
}

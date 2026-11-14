'use client';

// The adopted slash command groups also supply the explicit block picker. See README.md and LICENSE.
import { Command, CommandInput, CommandList } from '@rezics/ui/shadcn/command';
import type { Editor } from '@tiptap/core';
import { useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { EditorCommand } from '../../editor-commands.ts';
import type { RichTextEditorLabels } from '../../editor-labels.ts';
import { Menu, dismissMenuForNavigation } from '../../menu.tsx';
import { CommandListItems, filterCommandGroups } from './command-list.tsx';
import { productControlLabels } from './control-labels.ts';

interface BlockMenuProps {
  editor: Editor;
  labels: RichTextEditorLabels;
  title: string;
  trigger: ReactElement;
  commands: readonly EditorCommand[];
  selectedBlock?: string | undefined;
  isCurrent: () => boolean;
  onSelect: (command: EditorCommand) => void;
  onOpenChange: (open: boolean) => void;
}

function BlockMenuContent({ editor, labels, title, commands, selectedBlock, isCurrent, onSelect, onOpenChange }: BlockMenuProps) {
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const admitted = useRef({ doc: editor.state.doc, selection: editor.state.selection });
  const latestOpenChange = useRef(onOpenChange);
  latestOpenChange.current = onOpenChange;
  const choices = filterCommandGroups(commands, labels, query).flatMap((group) => group.commands);
  useLayoutEffect(() => {
    latestOpenChange.current(true);
    return () => latestOpenChange.current(false);
  }, []);

  return (
    <Command
      ref={root}
      shouldFilter={false}
      loop
      label={title}
      className="w-72 max-w-full"
      onKeyDownCapture={(event) => { if (event.nativeEvent.isComposing || event.keyCode === 229) event.stopPropagation(); }}
    >
      <CommandInput
        aria-label={labels.searchBlocks ?? productControlLabels.searchBlocks}
        placeholder={labels.searchBlocks ?? productControlLabels.searchBlocks}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList label={title}>
        {choices.length ? (
          <CommandListItems
            commands={choices}
            labels={labels}
            selectedBlock={selectedBlock}
            onSelect={(command) => {
              if (!isCurrent() || editor.isDestroyed || !editor.isEditable || editor.view.composing) return;
              if (editor.state.doc !== admitted.current.doc || !editor.state.selection.eq(admitted.current.selection)) return;
              dismissMenuForNavigation(root.current);
              onSelect(command);
            }}
          />
        ) : <p className="p-3 text-sm text-muted-foreground">{labels.slashEmpty}</p>}
      </CommandList>
    </Command>
  );
}

/** Public responsive Menu owns focus and touch presentation; REZICS retires a changed command target. */
export function BlockMenu(props: BlockMenuProps) {
  const [revision, setRevision] = useState(0);
  const scope = useMemo(() => ({}), [props.editor, props.isCurrent]);
  useLayoutEffect(() => {
    const retire = ({ transaction }: { transaction: import('@tiptap/pm/state').Transaction }) => {
      if (transaction.docChanged) setRevision((value) => value + 1);
    };
    const retireSelection = () => setRevision((value) => value + 1);
    props.editor.on('transaction', retire);
    props.editor.on('selectionUpdate', retireSelection);
    return () => {
      props.editor.off('transaction', retire);
      props.editor.off('selectionUpdate', retireSelection);
    };
  }, [props.editor]);

  return (
    <Menu
      key={revision}
      title={props.title}
      trigger={props.trigger}
      closeOnNavigation
      navigationScope={scope}
      content={<BlockMenuContent {...props} />}
    />
  );
}

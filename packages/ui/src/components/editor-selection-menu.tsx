'use client';

import { isNodeSelection, type Editor as TiptapEditor } from '@tiptap/core';
import { BubbleMenu } from '@tiptap/react/menus';
import { ChevronDownIcon, MoreHorizontalIcon, TableIcon, Trash2Icon } from 'lucide-react';
import { memo, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { Button } from './button.tsx';
import {
  alignCommands, availableCommands, blockActionCommands, blockCommands, commandById, describeCommand, formatShortcut, markCommands, tableCommands, useCommandState,
  type CommandIO, type EditorCommand,
} from './editor-commands.tsx';
import type { RichTextEditorLabels } from './editor-labels.tsx';
import { LinkField, type LinkRange } from './editor-link.tsx';
import { bubbleOptions } from './editor-surface.ts';
import { Menu, MenuContent, MenuGroup, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuShortcut, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger } from './menu.tsx';

type State = ReturnType<typeof useCommandState>;
type MenuName = 'turn' | 'more';

function Shortcut({ command }: { command: EditorCommand }) {
  const shortcut = formatShortcut(command.shortcut);
  return shortcut ? <MenuShortcut>{shortcut}</MenuShortcut> : null;
}

function IconCommand({ editor, command, labels, io, state }: { editor: TiptapEditor; command: EditorCommand; labels: RichTextEditorLabels; io: CommandIO; state: State }) {
  const active = state.isActive(command.id);
  return <Button size="icon-sm" variant={active ? 'soft' : 'ghost'} aria-label={labels[command.label]} title={describeCommand(command, labels)}
    aria-pressed={command.active ? active : undefined} disabled={state.isDisabled(command.id)} onClick={() => command.run(editor, io)}>
    <command.icon aria-hidden="true" />
  </Button>;
}

/**
 * The selection's line boxes. With Floating UI's `inline` middleware the panel sits over the first
 * line of a multi-line selection rather than over the paragraph's whole bounding box.
 */
function selectionLines(editor: TiptapEditor) {
  const { from, to } = editor.state.selection;
  const start = editor.view.domAtPos(from), end = editor.view.domAtPos(to);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  const lines = [...range.getClientRects()].filter(rect => rect.width > 0 || rect.height > 0);
  const bounds = range.getBoundingClientRect();
  return { getBoundingClientRect: () => bounds, getClientRects: () => lines.length ? lines : [bounds] };
}

/** Arrow keys move between the panel's buttons, and Escape returns to the text. */
function moveFocus(event: ReactKeyboardEvent<HTMLElement>, editor: TiptapEditor) {
  if (event.key === 'Escape') { event.preventDefault(); editor.commands.focus(); return; }
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
  if (!step || (event.target as HTMLElement).closest('input')) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
  const index = buttons.indexOf(event.target as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  buttons[(index + step + buttons.length) % buttons.length]?.focus();
}

/**
 * The pointer's selection panel: a compact grid of icons over the selection, where the eye
 * already is, flipping below it near the top of the view. Alt+F10 moves keyboard focus into it.
 */
/** Characters in the selection, counted as a reader sees them: code points, with block breaks as one. */
function selectedLength(editor: TiptapEditor): number {
  const { from, to } = editor.state.selection;
  return Array.from(editor.state.doc.textBetween(from, to, '\n', ' ')).length;
}

/**
 * The pointer's selection panel: a compact grid of icons over the selection, where the eye
 * already is, flipping below it near the top of the view. Block type opens a list; More opens the
 * actions on the blocks the selection touches. Alt+F10 moves keyboard focus into the panel.
 */
export const SelectionMenu = memo(function SelectionMenu({ editor, labels, blocks, io, linkRange, onLinkClose, container }: {
  editor: TiptapEditor; labels: RichTextEditorLabels; blocks: boolean; io: CommandIO; linkRange: LinkRange | null; onLinkClose: () => void;
  /** Where the panel is placed: outside the document, so the document's own styles never reach it. */
  container: RefObject<HTMLElement | null>;
}) {
  const state = useCommandState(editor);
  const [menu, setMenu] = useState<MenuName | null>(null);
  // A menu belongs to the selection it was opened on. The event fires with the transaction, so a late render never closes one.
  useEffect(() => {
    const close = () => setMenu(null);
    editor.on('selectionUpdate', close);
    return () => { editor.off('selectionUpdate', close); };
  }, [editor]);
  const options = useMemo(() => ({ ...bubbleOptions, placement: 'top' as const, inline: true, onHide: () => setMenu(null) }), []);
  const current = commandById(state.block);
  const row = (commands: readonly EditorCommand[]) => commands.map(command => <IconCommand key={command.id} editor={editor} command={command} labels={labels} io={io} state={state} />);
  // A menu returns focus to its trigger as it closes; the command runs after that, so the caret ends in the text.
  const choose = (command: EditorCommand) => { setMenu(null); requestAnimationFrame(() => command.run(editor, io)); };
  const opened = (name: MenuName) => ({ open: menu === name, onOpenChange: ({ open }: { open: boolean }) => setMenu(open ? name : null) });
  const radio = (commands: readonly EditorCommand[], value: string) => <MenuRadioGroup value={value} onValueChange={({ value: id }) => choose(commandById(id))}>
    {commands.map(command => <MenuRadioItem key={command.id} value={command.id}><command.icon aria-hidden="true" />{labels[command.label]}<Shortcut command={command} /></MenuRadioItem>)}
  </MenuRadioGroup>;
  const align = alignCommands.find(command => state.isActive(command.id)) ?? alignCommands[0]!;
  return <BubbleMenu editor={editor} pluginKey="rezicsSelectionMenu" updateDelay={80} options={options} getReferencedVirtualElement={() => selectionLines(editor)}
    appendTo={() => container.current ?? editor.view.dom.parentElement ?? document.body}
    shouldShow={({ editor: live, element, view: editorView, state: editorState }) => live.isEditable && !isNodeSelection(editorState.selection) && !editorState.selection.empty
      && (editorView.hasFocus() || element.contains(document.activeElement))}
    className="max-w-[calc(100vw-1rem)]" data-slot="editor-selection-menu">
    <div role="toolbar" aria-label={labels.formatting} className="relative w-fit max-w-full rounded-xl border border-border/60 bg-popover p-1 text-popover-foreground shadow-(--aura-shadow-float)"
      onKeyDown={event => moveFocus(event, editor)}
      onMouseDown={event => { if (!(event.target as HTMLElement).closest('input')) event.preventDefault(); }}>
      {linkRange ? <div className="w-64 max-w-full p-0.5"><LinkField editor={editor} labels={labels} range={linkRange} onClose={onLinkClose} /></div> : <>
        <Menu positioning={{ placement: 'bottom-start' }} {...opened('turn')}>
          <MenuTrigger asChild><Button size="sm" variant="ghost" className="w-full justify-start px-2" aria-label={`${labels.turnInto}: ${labels[current.label]}`}>
            <current.icon aria-hidden="true" /><span className="min-w-0 flex-1 truncate text-start">{labels[current.label]}</span><ChevronDownIcon aria-hidden="true" />
          </Button></MenuTrigger>
          <MenuContent inline aria-label={labels.turnInto}>{radio(availableCommands(blockCommands, blocks), state.block)}</MenuContent>
        </Menu>
        <div className="mt-0.5 flex gap-0.5" role="group" aria-label={labels.toolbar}>{row(markCommands)}</div>
        <div className="mt-0.5 flex gap-0.5">
          {row(['link', 'ruby', 'emphasis', 'clearFormatting'].map(commandById))}
          <Menu positioning={{ placement: 'bottom-start' }} {...opened('more')}>
            <MenuTrigger asChild><Button size="icon-sm" variant={menu === 'more' ? 'soft' : 'ghost'} aria-label={labels.moreFormatting} title={labels.moreFormatting}>
              <MoreHorizontalIcon aria-hidden="true" /></Button></MenuTrigger>
            <MenuContent inline aria-label={labels.moreFormatting} className="w-64">
              <MenuGroup heading={labels.block}>
                <MenuSub positioning={{ placement: 'right-start' }}>
                  <MenuSubTrigger><current.icon aria-hidden="true" />{labels.turnInto}</MenuSubTrigger>
                  <MenuSubContent inline aria-label={labels.turnInto}>{radio(availableCommands(blockCommands, blocks), state.block)}</MenuSubContent>
                </MenuSub>
                <MenuSub positioning={{ placement: 'right-start' }}>
                  <MenuSubTrigger><align.icon aria-hidden="true" />{labels.alignment}</MenuSubTrigger>
                  <MenuSubContent inline aria-label={labels.alignment}>{radio(alignCommands, align.id)}</MenuSubContent>
                </MenuSub>
                {blocks && state.inTable ? <MenuSub positioning={{ placement: 'right-start' }}>
                  <MenuSubTrigger><TableIcon aria-hidden="true" />{labels.tableMenu}</MenuSubTrigger>
                  <MenuSubContent inline aria-label={labels.tableMenu}>
                    {tableCommands.map(command => <MenuItem key={command.id} value={command.id} onClick={() => choose(command)}><command.icon aria-hidden="true" />{labels[command.label]}</MenuItem>)}
                  </MenuSubContent>
                </MenuSub> : null}
              </MenuGroup>
              <MenuSeparator />
              {blockActionCommands.filter(command => command.id !== 'deleteBlock').map(command => <MenuItem key={command.id} value={command.id}
                disabled={state.isDisabled(command.id)} onClick={() => choose(command)}><command.icon aria-hidden="true" />{labels[command.label]}<Shortcut command={command} /></MenuItem>)}
              <MenuSeparator />
              <MenuItem value="deleteBlock" variant="destructive" onClick={() => choose(commandById('deleteBlock'))}><Trash2Icon aria-hidden="true" />{labels.deleteBlock}</MenuItem>
              <MenuSeparator />
              <p className="px-3 py-1 text-xs text-muted-foreground">{labels.selectedCharacters.replace('{count}', String(selectedLength(editor)))}</p>
            </MenuContent>
          </Menu>
        </div>
      </>}
    </div>
  </BubbleMenu>;
});

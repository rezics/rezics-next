'use client';

import type { Editor as TiptapEditor, JSONContent } from '@tiptap/core';
import { ClipboardPasteIcon, CopyIcon, ScissorsIcon, TypeIcon, UnlinkIcon } from 'lucide-react';
import { useRef, type ReactNode, type RefObject } from 'react';
import { Button } from './button.tsx';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from './context-menu.tsx';
import {
  alignCommands, availableCommands, blockCommands, commandById, formatShortcut, inlineCommands, insertOnlyCommands, markCommands, tableCommands, useCommandState,
  type CommandIO, type EditorCommand,
} from './editor-commands.tsx';
import type { RichTextEditorLabels } from './editor-labels.tsx';
import { MenuCheckboxItem, MenuGroup, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuShortcut, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger } from './menu.tsx';

/** Cut and copy keep rich content through the browser's own command, and fall back to plain text where it refuses. */
function copySelection(editor: TiptapEditor, cut: boolean) {
  editor.view.focus();
  if (document.execCommand(cut ? 'cut' : 'copy')) return;
  const { from, to } = editor.state.selection;
  void navigator.clipboard?.writeText(editor.state.doc.textBetween(from, to, '\n\n'));
  if (cut) editor.commands.deleteSelection();
}

/** Pasted text is inserted as text nodes, never parsed as markup. */
async function pastePlain(editor: TiptapEditor) {
  const text = await navigator.clipboard?.readText().catch(() => '') ?? '';
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const content: JSONContent[] = lines.length === 1
    ? [{ type: 'text', text: lines[0]! }]
    : lines.map(line => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] }));
  if (text) editor.chain().focus().insertContent(content).run();
}

function Shortcut({ command }: { command: EditorCommand }) {
  const shortcut = formatShortcut(command.shortcut);
  return shortcut ? <MenuShortcut>{shortcut}</MenuShortcut> : null;
}

function FormattingMenuItems({ editor, labels, io, blocks, restore }: {
  editor: TiptapEditor; labels: RichTextEditorLabels; io: CommandIO; blocks: boolean; restore: () => void;
}) {
  const state = useCommandState(editor);
  const run = (command: EditorCommand) => { restore(); command.run(editor, io); };
  const inline = inlineCommands.filter(command => command.id !== 'clearFormatting' || !state.empty);
  const inserts = availableCommands(insertOnlyCommands, blocks);
  const block = commandById(state.block);
  const align = alignCommands.find(command => state.isActive(command.id)) ?? alignCommands[0]!;
  return <>
    <MenuGroup>
      {!state.empty ? <>
        <MenuItem value="cut" onClick={() => { restore(); copySelection(editor, true); }}><ScissorsIcon aria-hidden="true" />{labels.cut}<MenuShortcut>{formatShortcut('Mod-x')}</MenuShortcut></MenuItem>
        <MenuItem value="copy" onClick={() => { restore(); copySelection(editor, false); }}><CopyIcon aria-hidden="true" />{labels.copy}<MenuShortcut>{formatShortcut('Mod-c')}</MenuShortcut></MenuItem>
      </> : null}
      <MenuItem value="pastePlain" onClick={() => { restore(); void pastePlain(editor); }}><ClipboardPasteIcon aria-hidden="true" />{labels.pastePlain}</MenuItem>
    </MenuGroup>
    <MenuSeparator />
    <MenuGroup>
      <MenuSub positioning={{ placement: 'right-start' }}>
        <MenuSubTrigger><block.icon aria-hidden="true" />{labels.turnInto}: {labels[block.label]}</MenuSubTrigger>
        <MenuSubContent aria-label={labels.turnInto}>
          <MenuRadioGroup value={state.block} onValueChange={({ value }) => run(commandById(value))}>
            {availableCommands(blockCommands, blocks).map(command => <MenuRadioItem key={command.id} value={command.id}><command.icon aria-hidden="true" />{labels[command.label]}<Shortcut command={command} /></MenuRadioItem>)}
          </MenuRadioGroup>
        </MenuSubContent>
      </MenuSub>
    </MenuGroup>
    <MenuSeparator />
    <MenuGroup>
      {markCommands.map(command => <MenuCheckboxItem key={command.id} value={command.id} checked={state.isActive(command.id)} onCheckedChange={() => run(command)}>
        <command.icon aria-hidden="true" />{labels[command.label]}<Shortcut command={command} />
      </MenuCheckboxItem>)}
    </MenuGroup>
    <MenuSeparator />
    <MenuGroup>
      {inline.map(command => <MenuItem key={command.id} value={command.id} disabled={state.isDisabled(command.id)} onClick={() => run(command)}>
        <command.icon aria-hidden="true" />{labels[command.label]}{command.id === 'ruby' || command.id === 'emphasis' ? '…' : ''}<Shortcut command={command} />
      </MenuItem>)}
      {state.isActive('link') ? <MenuItem value="unlink" onClick={() => { restore(); editor.chain().focus().extendMarkRange('link').unsetLink().run(); }}><UnlinkIcon aria-hidden="true" />{labels.unlink}</MenuItem> : null}
    </MenuGroup>
    <MenuSeparator />
    <MenuGroup>
      <MenuSub positioning={{ placement: 'right-start' }}>
        <MenuSubTrigger><align.icon aria-hidden="true" />{labels.alignment}</MenuSubTrigger>
        <MenuSubContent aria-label={labels.alignment}>
          <MenuRadioGroup value={align.id} onValueChange={({ value }) => run(commandById(value))}>
            {alignCommands.map(command => <MenuRadioItem key={command.id} value={command.id}><command.icon aria-hidden="true" />{labels[command.label]}</MenuRadioItem>)}
          </MenuRadioGroup>
        </MenuSubContent>
      </MenuSub>
    </MenuGroup>
    {inserts.length ? <><MenuSeparator /><MenuGroup heading={labels.insertBlock}>
      {inserts.map(command => <MenuItem key={command.id} value={command.id} onClick={() => run(command)}><command.icon aria-hidden="true" />{command.id === 'table' ? labels.table : labels[command.label]}</MenuItem>)}
    </MenuGroup></> : null}
    {blocks && state.inTable ? <><MenuSeparator /><MenuGroup heading={labels.table}>
      {tableCommands.map(command => <MenuItem key={command.id} value={command.id} onClick={() => run(command)}><command.icon aria-hidden="true" />{labels[command.label]}</MenuItem>)}
    </MenuGroup></> : null}
  </>;
}

/**
 * Right-click and Shift+F10 / Alt+F10 open the same commands as the selection panel, as a menu a
 * keyboard can walk. The selection is remembered when the menu opens because choosing an item moves focus.
 */
export function ContextFormatting({ editor, labels, io, blocks, triggerRef, children }: {
  editor: TiptapEditor; labels: RichTextEditorLabels; io: CommandIO; blocks: boolean; triggerRef: RefObject<HTMLButtonElement | null>; children: ReactNode;
}) {
  const saved = useRef<{ from: number; to: number } | null>(null);
  const remember = () => { const { from, to } = editor.state.selection; saved.current = { from, to }; };
  const restore = () => { if (saved.current) editor.commands.setTextSelection(saved.current); };
  return <ContextMenu onOpenChange={({ open }) => { if (open) { if (!saved.current) remember(); restore(); } }}>
    <ContextMenuTrigger asChild style={{ userSelect: 'text', WebkitUserSelect: 'text', WebkitTouchCallout: 'default' }}><div onPointerDownCapture={event => { if (event.button === 2) remember(); }}
      onKeyDownCapture={event => { if (event.key === 'F10' && event.shiftKey) remember(); }}>{children}</div></ContextMenuTrigger>
    <div className="mt-2 flex justify-end"><MenuTrigger asChild><Button ref={triggerRef} size="sm" variant="ghost" title={`${labels.formatting} (Alt+F10)`}
      onPointerDown={remember} onMouseDown={event => event.preventDefault()} onKeyDown={remember} onClick={remember}><TypeIcon aria-hidden="true" />{labels.formatting}</Button></MenuTrigger></div>
    <ContextMenuContent aria-label={labels.formatting} aria-labelledby="">
      <FormattingMenuItems editor={editor} labels={labels} io={io} blocks={blocks} restore={restore} />
    </ContextMenuContent>
  </ContextMenu>;
}

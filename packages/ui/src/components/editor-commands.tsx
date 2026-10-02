'use client';

import type { Editor as TiptapEditor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Selection } from '@tiptap/pm/state';
import { useEditorState } from '@tiptap/react';
import {
  AlignCenterIcon, AlignJustifyIcon, AlignLeftIcon, AlignRightIcon, BetweenHorizontalStartIcon, BetweenVerticalStartIcon, BoldIcon, Columns3Icon, CodeIcon, CodeXmlIcon, EyeOffIcon, Heading1Icon, Heading2Icon, Heading3Icon,
  ImageIcon, ItalicIcon, LanguagesIcon, LinkIcon, ListChecksIcon, ListIcon, ListOrderedIcon, MinusIcon, PilcrowIcon, QuoteIcon, RedoIcon,
  RemoveFormattingIcon, Rows3Icon, SparklesIcon, StrikethroughIcon, TableIcon, Trash2Icon, UnderlineIcon, UndoIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { RichTextEditorLabels } from './editor-labels.tsx';

export type DialogMode = 'link' | 'ruby' | 'emphasis';
export type LabelKey = keyof RichTextEditorLabels;

/** What a command needs from the surface that runs it. Surfaces differ in how they collect input, not in what a command does. */
export interface CommandIO {
  openDialog: (mode: DialogMode) => void;
  /** Opens image insertion at the caret. */
  openImage: () => void;
  /** Surfaces with an inline link field edit there; the rest fall back to the dialog. */
  openLink?: () => void;
}

export interface EditorCommand {
  id: string;
  label: LabelKey;
  icon: LucideIcon;
  /** Tiptap key notation: `Mod-Shift-8`. */
  shortcut?: string;
  /** Extra words the slash menu matches besides the localized label. */
  keywords?: readonly string[];
  /** Commands that need table or image nodes exist only in the Blocks profile. */
  blocksOnly?: boolean;
  active?: (editor: TiptapEditor) => boolean;
  disabled?: (editor: TiptapEditor) => boolean;
  run: (editor: TiptapEditor, io: CommandIO) => void;
}

const run = (editor: TiptapEditor) => editor.chain().focus();

export function canAnnotateRuby(editor: TiptapEditor): boolean {
  const { $from, $to, from, to } = editor.state.selection;
  return editor.isActive('ruby') || ($from.sameParent($to) && editor.state.doc.slice(from, to).content.content.every(node => node.isText));
}

/** Attributes that identify a block rather than style it; they survive a change of block type. */
function carried(node: ProseMirrorNode): Record<string, unknown> {
  return Object.fromEntries(['id', 'lang', 'dir', 'textAlign'].flatMap(key => node.attrs[key] != null ? [[key, node.attrs[key]]] : []));
}

/** Inserting a block places it after the selection; it never replaces the text a writer selected. */
function collapseToEnd(editor: TiptapEditor) {
  run(editor).command(({ tr, state }) => {
    if (!state.selection.empty) tr.setSelection(Selection.near(state.doc.resolve(state.selection.to), -1));
    return true;
  }).run();
}

/** Lifts the selection out of lists and quotes without recreating its blocks, which would discard their identities. */
function unwrapBlocks(editor: TiptapEditor) {
  for (let depth = 0; depth < 8; depth++) {
    const lifted = editor.isActive('taskItem') ? editor.commands.liftListItem('taskItem')
      : editor.isActive('listItem') ? editor.commands.liftListItem('listItem')
        : editor.isActive('blockquote') ? editor.commands.lift('blockquote') : false;
    if (!lifted) return;
  }
}

/** Retypes every text block of the selection one by one, so each keeps its own identity. */
function setTextblock(editor: TiptapEditor, type: 'paragraph' | 'heading' | 'codeBlock', attrs: Record<string, unknown> = {}) {
  unwrapBlocks(editor);
  run(editor).command(({ tr, state }) => {
    const nodeType = state.schema.nodes[type]!;
    state.selection.ranges.forEach(({ $from, $to }) => tr.setBlockType($from.pos, $to.pos, nodeType, node => ({ ...carried(node), ...attrs })));
    return true;
  }).run();
}

/** Lists and quotes wrap paragraphs, so a heading or code block becomes a paragraph before it is wrapped. */
function wrapParagraph(editor: TiptapEditor, wrap: () => void) {
  if (editor.isActive('heading') || editor.isActive('codeBlock')) setTextblock(editor, 'paragraph');
  wrap();
}

const heading = (level: 1 | 2 | 3, icon: LucideIcon): EditorCommand => ({
  id: `heading${level}`, label: `heading${level}`, icon, shortcut: `Mod-Alt-${level}`, keywords: [`h${level}`, 'heading', 'title'],
  active: editor => editor.isActive('heading', { level }),
  run: editor => editor.isActive('heading', { level }) ? setTextblock(editor, 'paragraph') : setTextblock(editor, 'heading', { level }),
});

const mark = (id: string, label: LabelKey, icon: LucideIcon, shortcut?: string, keywords?: readonly string[]): EditorCommand => ({
  id, label, icon, shortcut, keywords, active: editor => editor.isActive(id), run: editor => { run(editor).toggleMark(id).run(); },
});

export const markCommands: readonly EditorCommand[] = [
  mark('bold', 'bold', BoldIcon, 'Mod-b'), mark('italic', 'italic', ItalicIcon, 'Mod-i'), mark('underline', 'underline', UnderlineIcon, 'Mod-u'),
  mark('strike', 'strike', StrikethroughIcon, 'Mod-Shift-s'),
  mark('code', 'inlineCode', CodeIcon, 'Mod-e'), mark('spoiler', 'spoiler', EyeOffIcon),
];

/** The block types a text block can become. Selecting the active one returns it to a paragraph. */
export const blockCommands: readonly EditorCommand[] = [
  { id: 'paragraph', label: 'paragraph', icon: PilcrowIcon, shortcut: 'Mod-Alt-0', keywords: ['text', 'paragraph', 'plain'],
    active: editor => !['heading', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock'].some(name => editor.isActive(name)),
    run: editor => setTextblock(editor, 'paragraph') },
  heading(1, Heading1Icon), heading(2, Heading2Icon), heading(3, Heading3Icon),
  { id: 'bulletList', label: 'bulletList', icon: ListIcon, shortcut: 'Mod-Shift-8', keywords: ['ul', 'bullet', 'list'],
    active: editor => editor.isActive('bulletList'), run: editor => wrapParagraph(editor, () => { run(editor).toggleBulletList().run(); }) },
  { id: 'orderedList', label: 'orderedList', icon: ListOrderedIcon, shortcut: 'Mod-Shift-7', keywords: ['ol', 'numbered', 'list'],
    active: editor => editor.isActive('orderedList'), run: editor => wrapParagraph(editor, () => { run(editor).toggleOrderedList().run(); }) },
  { id: 'taskList', label: 'taskList', icon: ListChecksIcon, shortcut: 'Mod-Shift-9', keywords: ['todo', 'task', 'checkbox', 'checklist'],
    active: editor => editor.isActive('taskList'), run: editor => wrapParagraph(editor, () => { run(editor).toggleTaskList().run(); }) },
  { id: 'blockquote', label: 'quote', icon: QuoteIcon, shortcut: 'Mod-Shift-b', keywords: ['quote', 'blockquote', 'citation'],
    active: editor => editor.isActive('blockquote'), run: editor => wrapParagraph(editor, () => { run(editor).toggleBlockquote().run(); }) },
  { id: 'codeBlock', label: 'codeBlock', icon: CodeXmlIcon, shortcut: 'Mod-Alt-c', keywords: ['code', 'pre', 'snippet'],
    active: editor => editor.isActive('codeBlock'), run: editor => setTextblock(editor, editor.isActive('codeBlock') ? 'paragraph' : 'codeBlock') },
];

export const inlineCommands: readonly EditorCommand[] = [
  { id: 'link', label: 'link', icon: LinkIcon, shortcut: 'Mod-k', active: editor => editor.isActive('link'), run: (_editor, io) => (io.openLink ?? (() => io.openDialog('link')))() },
  { id: 'ruby', label: 'ruby', icon: LanguagesIcon, disabled: editor => !canAnnotateRuby(editor), run: (_editor, io) => io.openDialog('ruby') },
  { id: 'emphasis', label: 'emphasis', icon: SparklesIcon, active: editor => editor.isActive('textEmphasis'), run: (_editor, io) => io.openDialog('emphasis') },
  { id: 'clearFormatting', label: 'clearFormatting', icon: RemoveFormattingIcon, disabled: editor => editor.state.selection.empty, run: editor => { run(editor).unsetAllMarks().run(); } },
];

const alignment = (value: 'left' | 'center' | 'right' | 'justify', icon: LucideIcon): EditorCommand => ({
  id: `align-${value}`, label: value, icon,
  active: editor => value === 'left'
    ? !['center', 'right', 'justify'].some(other => editor.isActive({ textAlign: other }))
    : editor.isActive({ textAlign: value }),
  run: editor => { run(editor).setTextAlign(value).run(); },
});

export const alignCommands: readonly EditorCommand[] = [
  alignment('left', AlignLeftIcon), alignment('center', AlignCenterIcon), alignment('right', AlignRightIcon), alignment('justify', AlignJustifyIcon),
];

/** Blocks that are inserted rather than converted to; the slash menu and insert panel list them after the block types. */
export const insertOnlyCommands: readonly EditorCommand[] = [
  { id: 'horizontalRule', label: 'horizontalRule', icon: MinusIcon, keywords: ['hr', 'divider', 'rule', 'line'], run: editor => { collapseToEnd(editor); run(editor).setHorizontalRule().run(); } },
  { id: 'image', label: 'image', icon: ImageIcon, blocksOnly: true, keywords: ['picture', 'photo', 'img'], run: (editor, io) => { collapseToEnd(editor); io.openImage(); } },
  { id: 'table', label: 'table', icon: TableIcon, blocksOnly: true, keywords: ['grid', 'rows', 'columns'], run: editor => { collapseToEnd(editor); run(editor).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); } },
];

export const insertCommands: readonly EditorCommand[] = [...blockCommands.filter(command => command.id !== 'paragraph'), ...insertOnlyCommands];

export const tableCommands: readonly EditorCommand[] = [
  { id: 'addRow', label: 'addRow', icon: BetweenHorizontalStartIcon, run: editor => { run(editor).addRowAfter().run(); } },
  { id: 'addColumn', label: 'addColumn', icon: BetweenVerticalStartIcon, run: editor => { run(editor).addColumnAfter().run(); } },
  { id: 'deleteRow', label: 'deleteRow', icon: Rows3Icon, run: editor => { run(editor).deleteRow().run(); } },
  { id: 'deleteColumn', label: 'deleteColumn', icon: Columns3Icon, run: editor => { run(editor).deleteColumn().run(); } },
  { id: 'deleteTable', label: 'deleteTable', icon: Trash2Icon, run: editor => { run(editor).deleteTable().run(); } },
];

export const historyCommands: readonly EditorCommand[] = [
  { id: 'undo', label: 'undo', icon: UndoIcon, shortcut: 'Mod-z', disabled: editor => !editor.can().undo(), run: editor => { run(editor).undo().run(); } },
  { id: 'redo', label: 'redo', icon: RedoIcon, shortcut: 'Mod-Shift-z', disabled: editor => !editor.can().redo(), run: editor => { run(editor).redo().run(); } },
];

const everyCommand: readonly EditorCommand[] = [
  ...markCommands, ...blockCommands, ...inlineCommands, ...alignCommands, ...insertOnlyCommands, ...tableCommands, ...historyCommands,
];

const byId = new Map(everyCommand.map(command => [command.id, command]));
export function commandById(id: string): EditorCommand {
  const command = byId.get(id);
  if (!command) throw new Error(`Unknown editor command: ${id}`);
  return command;
}

/** Commands outside the Blocks profile cannot create nodes that profile lacks. */
export function availableCommands(commands: readonly EditorCommand[], blocks: boolean): EditorCommand[] {
  return commands.filter(command => blocks || !command.blocksOnly);
}

export interface CommandState {
  active: readonly string[];
  disabled: readonly string[];
  /** The block type of the selection's first block, as a `blockCommands` id. */
  block: string;
  inTable: boolean;
  empty: boolean;
}

function currentBlock(editor: TiptapEditor): string {
  return blockCommands.find(command => command.id !== 'paragraph' && command.active?.(editor))?.id ?? 'paragraph';
}

/** Subscribes to the selection state that every surface renders from, so each surface stays in step with the document. */
export function useCommandState(editor: TiptapEditor): CommandState & { isActive: (id: string) => boolean; isDisabled: (id: string) => boolean } {
  const state = useEditorState({ editor, selector: ({ editor: current }): CommandState => ({
    active: everyCommand.filter(command => command.active?.(current)).map(command => command.id),
    disabled: everyCommand.filter(command => command.disabled?.(current)).map(command => command.id),
    block: currentBlock(current), inTable: current.isActive('table'), empty: current.state.selection.empty,
  }) });
  return { ...state, isActive: id => state.active.includes(id), isDisabled: id => state.disabled.includes(id) };
}

const isApple = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Renders Tiptap key notation for the reader's platform: `⌘⇧8` on Apple systems, `Ctrl+Shift+8` elsewhere. */
export function formatShortcut(shortcut: string | undefined): string | undefined {
  if (!shortcut) return undefined;
  const apple = isApple();
  const parts = shortcut.split('-').map(part => part === 'Mod' ? (apple ? '⌘' : 'Ctrl') : part === 'Shift' ? (apple ? '⇧' : 'Shift') : part === 'Alt' ? (apple ? '⌥' : 'Alt') : part.toUpperCase());
  return apple ? parts.join('') : parts.join('+');
}

export function describeCommand(command: EditorCommand, labels: RichTextEditorLabels): string {
  const shortcut = formatShortcut(command.shortcut);
  return shortcut ? `${labels[command.label]} (${shortcut})` : labels[command.label];
}

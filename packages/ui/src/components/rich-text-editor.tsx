'use client';

import { normalizeDocument, withDocumentIds, type DocumentNode, type DocumentSnapshot } from '@rezics/document';
import { type Editor as TiptapEditor, type JSONContent } from '@tiptap/core';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { BubbleMenu, FloatingMenu } from '@tiptap/react/menus';
import { BoldIcon, CodeIcon, CodeXmlIcon, EyeOffIcon, ImageIcon, ItalicIcon, LinkIcon, ListChecksIcon, ListIcon,
  ListOrderedIcon, MinusIcon, MoreHorizontalIcon, QuoteIcon, RedoIcon, StrikethroughIcon, TableIcon, TypeIcon, UnderlineIcon, UndoIcon, UnlinkIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { cn } from '../utils.ts';
import { Button } from './button.tsx';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from './context-menu.tsx';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from './dialog.tsx';
import { documentExtensions } from './document-extensions.tsx';
import { safeDocumentUrl } from './document-url.tsx';
import { Field, FieldGroup, FieldLabel } from './field.tsx';
import { Input } from './input.tsx';
import { Menu, MenuCheckboxItem, MenuContent, MenuGroup, MenuItem, MenuSeparator, MenuTrigger } from './menu.tsx';
import { NativeSelect, NativeSelectOption } from './native-select.tsx';
import { SkeletonText } from './skeleton.tsx';
import { ToggleGroup, ToggleGroupItem } from './toggle-group.tsx';

export const richTextEditorLabels = {
  toolbar: 'Text formatting', blockType: 'Block type', paragraph: 'Paragraph', heading1: 'Heading 1', heading2: 'Heading 2', heading3: 'Heading 3',
  bold: 'Bold', italic: 'Italic', underline: 'Underline', strike: 'Strikethrough', inlineCode: 'Inline code',
  link: 'Link', unlink: 'Remove link', bulletList: 'Bullet list', orderedList: 'Numbered list', taskList: 'Checklist',
  quote: 'Quote', codeBlock: 'Code block', horizontalRule: 'Divider', undo: 'Undo', redo: 'Redo',
  table: 'Insert table', image: 'Image', ruby: 'Ruby annotation', emphasis: 'Emphasis marks',
  apply: 'Apply', cancel: 'Cancel', remove: 'Remove', url: 'URL', imageAlt: 'Image description',
  annotation: 'Pronunciation', baseText: 'Base text', position: 'Position', over: 'Over', under: 'Under', interCharacter: 'Between characters',
  shape: 'Shape', dot: 'Dot', sesame: 'Sesame', circle: 'Circle', doubleCircle: 'Double circle', triangle: 'Triangle',
  fill: 'Fill', filled: 'Filled', open: 'Open', loading: 'Loading editor', unknownComponent: 'Embedded component',
  invalidUrl: 'Enter a web URL or a relative resource address.', addRow: 'Add row', addColumn: 'Add column', deleteRow: 'Delete row', deleteColumn: 'Delete column', deleteTable: 'Delete table',
  alignment: 'Alignment', left: 'Left', center: 'Center', right: 'Right', justify: 'Justify', insertBlock: 'Insert block',
  documentError: 'This change could not be saved. Undo it or reload the document.',
  spoiler: 'Spoiler', revealSpoiler: 'Reveal spoiler',
  formatting: 'Format text', moreFormatting: 'More formatting', advancedMode: 'Advanced tools', basicMode: 'Writing mode',
} satisfies Record<string, string>;
export type RichTextEditorLabels = { [K in keyof typeof richTextEditorLabels]: string };

export interface RichTextEditorProps {
  value: DocumentSnapshot;
  onChange: (document: DocumentSnapshot) => void;
  label: string;
  labels?: Partial<RichTextEditorLabels>;
  placeholder?: string;
  lang?: string;
  dir?: 'ltr' | 'rtl' | 'auto';
  className?: string;
  compact?: boolean;
  toolbarMode?: 'contextual' | 'full';
  disabled?: boolean;
  readOnly?: boolean;
  autoFocus?: boolean;
  maxLength?: number;
  onBlur?: () => void;
  onFocus?: () => void;
  onSave?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onSnapshotError?: (error: unknown) => void;
}

type DialogMode = 'link' | 'image' | 'ruby' | 'emphasis';
type Selection = { from: number; to: number; content?: JSONContent[]; attrs?: JSONContent['attrs']; marks?: JSONContent['marks'] };

function snapshot(editor: TiptapEditor, profile: DocumentSnapshot['profile']): DocumentSnapshot {
  return normalizeDocument({ version: 'rezics-document-v1', profile, doc: withDocumentIds(editor.getJSON() as DocumentNode) });
}

const marks = [
  { type: 'bold', label: 'bold', icon: BoldIcon }, { type: 'italic', label: 'italic', icon: ItalicIcon },
  { type: 'underline', label: 'underline', icon: UnderlineIcon }, { type: 'strike', label: 'strike', icon: StrikethroughIcon },
  { type: 'code', label: 'inlineCode', icon: CodeIcon },
  { type: 'spoiler', label: 'spoiler', icon: EyeOffIcon },
] as const;

function canAnnotateRuby(editor: TiptapEditor): boolean {
  return editor.isActive('ruby') || (editor.state.selection.$from.sameParent(editor.state.selection.$to)
    && editor.state.doc.slice(editor.state.selection.from, editor.state.selection.to).content.content.every(node => node.isText));
}

function FormattingMenuItems({ editor, labels, openDialog, restoreSelection, marksVisible = true, blocks = false }: {
  editor: TiptapEditor; labels: RichTextEditorLabels; openDialog: (mode: DialogMode) => void;
  restoreSelection?: () => void; marksVisible?: boolean; blocks?: boolean;
}) {
  useEditorState({ editor, selector: ({ editor: current }) => ({
    marks: marks.map(mark => current.isActive(mark.type)), link: current.isActive('link'), ruby: canAnnotateRuby(current), table: current.isActive('table'),
  }) });
  const run = (command: () => void) => { restoreSelection?.(); command(); };
  return <>
    <MenuGroup>
      {marksVisible ? marks.map(mark => <MenuCheckboxItem key={mark.type} value={mark.type} checked={editor.isActive(mark.type)}
        onCheckedChange={() => run(() => { editor.chain().focus().toggleMark(mark.type).run(); })}><mark.icon aria-hidden="true" />{labels[mark.label]}</MenuCheckboxItem>) : null}
      {marksVisible ? <MenuItem value="link" onClick={() => run(() => openDialog('link'))}><LinkIcon aria-hidden="true" />{labels.link}</MenuItem> : null}
      {editor.isActive('link') ? <MenuItem value="unlink" onClick={() => run(() => { editor.chain().focus().unsetLink().run(); })}>{labels.unlink}</MenuItem> : null}
      <MenuItem value="ruby" disabled={!canAnnotateRuby(editor)} onClick={() => run(() => openDialog('ruby'))}>{labels.ruby}</MenuItem>
      <MenuItem value="emphasis" onClick={() => run(() => openDialog('emphasis'))}>{labels.emphasis}</MenuItem>
    </MenuGroup>
    {marksVisible ? <><MenuSeparator /><MenuGroup heading={labels.insertBlock}>
      <MenuItem value="heading" onClick={() => run(() => { editor.chain().focus().toggleHeading({ level: 2 }).run(); })}>{labels.heading2}</MenuItem>
      <MenuItem value="bulletList" onClick={() => run(() => { editor.chain().focus().toggleBulletList().run(); })}><ListIcon aria-hidden="true" />{labels.bulletList}</MenuItem>
      <MenuItem value="orderedList" onClick={() => run(() => { editor.chain().focus().toggleOrderedList().run(); })}><ListOrderedIcon aria-hidden="true" />{labels.orderedList}</MenuItem>
      <MenuItem value="taskList" onClick={() => run(() => { editor.chain().focus().toggleTaskList().run(); })}><ListChecksIcon aria-hidden="true" />{labels.taskList}</MenuItem>
      <MenuItem value="quote" onClick={() => run(() => { editor.chain().focus().toggleBlockquote().run(); })}><QuoteIcon aria-hidden="true" />{labels.quote}</MenuItem>
      <MenuItem value="codeBlock" onClick={() => run(() => { editor.chain().focus().toggleCodeBlock().run(); })}><CodeXmlIcon aria-hidden="true" />{labels.codeBlock}</MenuItem>
      {blocks ? <><MenuItem value="image" onClick={() => run(() => openDialog('image'))}><ImageIcon aria-hidden="true" />{labels.image}</MenuItem>
        <MenuItem value="table" onClick={() => run(() => { editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); })}><TableIcon aria-hidden="true" />{labels.table}</MenuItem></> : null}
      <MenuItem value="horizontalRule" onClick={() => run(() => { editor.chain().focus().setHorizontalRule().run(); })}><MinusIcon aria-hidden="true" />{labels.horizontalRule}</MenuItem>
    </MenuGroup></> : null}
    {blocks && editor.isActive('table') ? <><MenuSeparator /><MenuGroup heading={labels.table}>
      <MenuItem value="addRow" onClick={() => run(() => { editor.chain().focus().addRowAfter().run(); })}>{labels.addRow}</MenuItem>
      <MenuItem value="addColumn" onClick={() => run(() => { editor.chain().focus().addColumnAfter().run(); })}>{labels.addColumn}</MenuItem>
      <MenuItem value="deleteRow" onClick={() => run(() => { editor.chain().focus().deleteRow().run(); })}>{labels.deleteRow}</MenuItem>
      <MenuItem value="deleteColumn" onClick={() => run(() => { editor.chain().focus().deleteColumn().run(); })}>{labels.deleteColumn}</MenuItem>
      <MenuItem value="deleteTable" onClick={() => run(() => { editor.chain().focus().deleteTable().run(); })}>{labels.deleteTable}</MenuItem>
    </MenuGroup></> : null}
  </>;
}

// Tiptap initializes its menu as absolute. Matching that strategy keeps the first placement
// in the same coordinate system as later updates inside a positioned writing surface.
const bubbleOptions = { placement: 'top' as const, strategy: 'absolute' as const, offset: 8, flip: true, shift: { padding: 8 } };

function SelectionMenu({ editor, labels, openDialog }: { editor: TiptapEditor; labels: RichTextEditorLabels; openDialog: (mode: DialogMode) => void }) {
  const active = useEditorState({ editor, selector: ({ editor: current }) => marks.filter(mark => current.isActive(mark.type)).map(mark => mark.type) });
  return <BubbleMenu editor={editor} pluginKey="rezicsSelectionMenu" updateDelay={80} options={bubbleOptions}
    className="max-w-[calc(100vw-1rem)]" data-slot="editor-selection-menu">
    <div role="group" aria-label={labels.formatting} className="flex max-w-full flex-wrap items-center gap-1 rounded-xl border border-border/60 bg-popover p-1 text-popover-foreground shadow-(--aura-shadow-float)">
      <ToggleGroup value={active} size="sm" aria-label={labels.toolbar} onValueChange={({ value }) => {
        const changed = marks.find(mark => value.includes(mark.type) !== active.includes(mark.type));
        if (changed) editor.chain().focus().toggleMark(changed.type).run();
      }}>
        {marks.map(mark => <ToggleGroupItem key={mark.type} value={mark.type} aria-label={labels[mark.label]} title={labels[mark.label]} onMouseDown={event => event.preventDefault()}><mark.icon aria-hidden="true" /></ToggleGroupItem>)}
      </ToggleGroup>
      <Button size="icon-sm" variant="ghost" aria-label={labels.link} title={labels.link} onMouseDown={event => event.preventDefault()} onClick={() => openDialog('link')}><LinkIcon aria-hidden="true" /></Button>
      <Menu><MenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={labels.moreFormatting} title={labels.moreFormatting} onMouseDown={event => event.preventDefault()}><MoreHorizontalIcon aria-hidden="true" /></Button></MenuTrigger>
        <MenuContent aria-label={labels.moreFormatting}><FormattingMenuItems editor={editor} labels={labels} openDialog={openDialog} marksVisible={false} /></MenuContent>
      </Menu>
    </div>
  </BubbleMenu>;
}

function ContextFormatting({ editor, labels, openDialog, blocks, triggerRef, children }: {
  editor: TiptapEditor; labels: RichTextEditorLabels; openDialog: (mode: DialogMode) => void; blocks: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>; children: ReactNode;
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
      <FormattingMenuItems editor={editor} labels={labels} openDialog={openDialog} restoreSelection={restore} blocks={blocks} />
    </ContextMenuContent>
  </ContextMenu>;
}

function Toolbar({ editor, labels, openDialog, blocks }: { editor: TiptapEditor; labels: RichTextEditorLabels; openDialog: (mode: DialogMode) => void; blocks: boolean }) {
  const state = useEditorState({ editor, selector: ({ editor: current }) => ({
    marks: marks.filter(mark => current.isActive(mark.type)).map(mark => mark.type),
    heading: current.isActive('heading') ? String(current.getAttributes('heading').level) : 'paragraph',
    bulletList: current.isActive('bulletList'), orderedList: current.isActive('orderedList'), taskList: current.isActive('taskList'),
    quote: current.isActive('blockquote'), codeBlock: current.isActive('codeBlock'), table: current.isActive('table'), link: current.isActive('link'),
    align: String(current.getAttributes('paragraph').textAlign ?? current.getAttributes('heading').textAlign ?? 'left'),
    ruby: current.isActive('ruby') || (current.state.selection.$from.sameParent(current.state.selection.$to)
      && current.state.doc.slice(current.state.selection.from, current.state.selection.to).content.content.every(node => node.isText)),
    undo: current.can().undo(), redo: current.can().redo(),
  }) });
  function action(label: string, icon: LucideIcon, command: () => void, pressed?: boolean, disabled = false) {
    const Icon = icon;
    return <Button size="icon-sm" variant={pressed ? 'soft' : 'ghost'} aria-label={label} title={label} aria-pressed={pressed}
      disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={command}><Icon aria-hidden="true" /></Button>;
  }
  return <div role="group" aria-label={labels.toolbar} className="flex flex-wrap items-center gap-1 border-b border-border/60 p-2" data-slot="editor-toolbar">
    <Field className="w-auto"><NativeSelect aria-label={labels.blockType} size="sm" value={state.heading} onChange={event => {
      const value = event.target.value;
      if (value === 'paragraph') editor.chain().focus().setParagraph().run();
      else editor.chain().focus().setHeading({ level: Number(value) as 1 | 2 | 3 }).run();
    }}><NativeSelectOption value="paragraph">{labels.paragraph}</NativeSelectOption>
      <NativeSelectOption value="1">{labels.heading1}</NativeSelectOption><NativeSelectOption value="2">{labels.heading2}</NativeSelectOption><NativeSelectOption value="3">{labels.heading3}</NativeSelectOption>
    </NativeSelect></Field>
    <ToggleGroup value={state.marks} onValueChange={({ value }) => {
      const changed = marks.find(mark => value.includes(mark.type) !== state.marks.includes(mark.type));
      if (changed) editor.chain().focus().toggleMark(changed.type).run();
    }} aria-label={labels.toolbar} size="sm">
      {marks.map(mark => <ToggleGroupItem key={mark.type} value={mark.type} aria-label={labels[mark.label]} title={labels[mark.label]} onMouseDown={event => event.preventDefault()}><mark.icon aria-hidden="true" /></ToggleGroupItem>)}
    </ToggleGroup>
    {action(labels.link, LinkIcon, () => openDialog('link'), state.link)}
    {state.link ? action(labels.unlink, UnlinkIcon, () => editor.chain().focus().unsetLink().run()) : null}
    {action(labels.bulletList, ListIcon, () => editor.chain().focus().toggleBulletList().run(), state.bulletList)}
    {action(labels.orderedList, ListOrderedIcon, () => editor.chain().focus().toggleOrderedList().run(), state.orderedList)}
    {action(labels.taskList, ListChecksIcon, () => editor.chain().focus().toggleTaskList().run(), state.taskList)}
    {action(labels.quote, QuoteIcon, () => editor.chain().focus().toggleBlockquote().run(), state.quote)}
    {action(labels.codeBlock, CodeXmlIcon, () => editor.chain().focus().toggleCodeBlock().run(), state.codeBlock)}
    <Field className="w-auto"><NativeSelect aria-label={labels.alignment} size="sm" value={state.align} onChange={event => editor.chain().focus().setTextAlign(event.target.value).run()}>
      {(['left', 'center', 'right', 'justify'] as const).map(value => <NativeSelectOption key={value} value={value}>{labels[value]}</NativeSelectOption>)}
    </NativeSelect></Field>
    <Button size="sm" variant="ghost" disabled={!state.ruby} onMouseDown={event => event.preventDefault()} onClick={() => openDialog('ruby')}>{labels.ruby}</Button>
    <Button size="sm" variant="ghost" onMouseDown={event => event.preventDefault()} onClick={() => openDialog('emphasis')}>{labels.emphasis}</Button>
    {blocks ? <>{action(labels.table, TableIcon, () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
      {action(labels.image, ImageIcon, () => openDialog('image'))}</> : null}
    {action(labels.horizontalRule, MinusIcon, () => editor.chain().focus().setHorizontalRule().run())}
    {action(labels.undo, UndoIcon, () => editor.chain().focus().undo().run(), undefined, !state.undo)}
    {action(labels.redo, RedoIcon, () => editor.chain().focus().redo().run(), undefined, !state.redo)}
    {state.table ? <div role="group" aria-label={labels.table} className="flex w-full flex-wrap gap-1 border-t border-border/60 pt-2">
      <Button size="sm" variant="ghost" onMouseDown={event => event.preventDefault()} onClick={() => editor.chain().focus().addRowAfter().run()}>{labels.addRow}</Button>
      <Button size="sm" variant="ghost" onMouseDown={event => event.preventDefault()} onClick={() => editor.chain().focus().addColumnAfter().run()}>{labels.addColumn}</Button>
      <Button size="sm" variant="ghost" onMouseDown={event => event.preventDefault()} onClick={() => editor.chain().focus().deleteRow().run()}>{labels.deleteRow}</Button>
      <Button size="sm" variant="ghost" onMouseDown={event => event.preventDefault()} onClick={() => editor.chain().focus().deleteColumn().run()}>{labels.deleteColumn}</Button>
      <Button size="sm" variant="ghost" onMouseDown={event => event.preventDefault()} onClick={() => editor.chain().focus().deleteTable().run()}>{labels.deleteTable}</Button>
    </div> : null}
  </div>;
}

/** A controlled Tiptap document editor. Initial hydration and controlled value updates never save a document. */
export function RichTextEditor({ value, onChange, label, labels: labelOverrides, placeholder, lang, dir, className, compact = false, toolbarMode = 'contextual',
  disabled = false, readOnly = false, autoFocus = false, maxLength, onBlur, onFocus, onSave, onKeyDown, onSnapshotError }: RichTextEditorProps) {
  const labels = useMemo(() => ({ ...richTextEditorLabels, ...labelOverrides }), [labelOverrides]);
  const initial = useMemo(() => normalizeDocument({ ...value, doc: withDocumentIds(value.doc) }), [value]);
  const latest = useRef({ onChange, onBlur, onFocus, onSave, onSnapshotError, profile: value.profile });
  latest.current = { onChange, onBlur, onFocus, onSave, onSnapshotError, profile: value.profile };
  const lastValue = useRef(JSON.stringify(initial));
  const editable = !disabled && !readOnly;
  const fieldId = useId();
  const formatTriggerRef = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<DialogMode | null>(null);
  const previousMode = useRef<DialogMode>('link');
  const [url, setUrl] = useState('');
  const [detail, setDetail] = useState('');
  const [baseText, setBaseText] = useState('');
  const [position, setPosition] = useState('over');
  const [shape, setShape] = useState('dot');
  const [fill, setFill] = useState('filled');
  const [invalidUrl, setInvalidUrl] = useState(false);
  const [snapshotError, setSnapshotError] = useState(false);
  const selection = useRef<Selection>({ from: 0, to: 0 });
  const extensions = useMemo(() => documentExtensions({ placeholder, unknownComponentLabel: labels.unknownComponent, maxLength, blocks: value.profile === 'blocks' }), [placeholder, labels.unknownComponent, maxLength, value.profile]);
  function publish(current: TiptapEditor) {
    if (current.view.composing) return;
    try {
      const next = snapshot(current, latest.current.profile);
      const serialized = JSON.stringify(next);
      setSnapshotError(false);
      if (serialized === lastValue.current) return;
      lastValue.current = serialized;
      latest.current.onChange(next);
    } catch (error) {
      setSnapshotError(true);
      latest.current.onSnapshotError?.(error);
    }
  }
  const editor = useEditor({
    extensions, content: initial.doc as JSONContent, immediatelyRender: false, shouldRerenderOnTransaction: false,
    editable, autofocus: autoFocus, enableContentCheck: true,
    onUpdate: ({ editor: current }) => publish(current),
    onBlur: () => latest.current.onBlur?.(), onFocus: () => latest.current.onFocus?.(),
    editorProps: {
      attributes: { role: 'textbox', 'aria-label': label, 'aria-multiline': 'true', 'aria-readonly': String(readOnly), 'aria-disabled': String(disabled), spellcheck: 'true', ...(lang ? { lang } : {}), ...(dir ? { dir } : {}) },
    },
  }, [value.profile]);
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editable, false);
    editor.setOptions({ editorProps: { ...editor.options.editorProps, attributes: {
      role: 'textbox', 'aria-label': label, 'aria-multiline': 'true', 'aria-readonly': String(readOnly), 'aria-disabled': String(disabled), spellcheck: 'true', ...(lang ? { lang } : {}), ...(dir ? { dir } : {}),
    } } });
  }, [editor, editable, label, readOnly, disabled, lang, dir]);
  useEffect(() => {
    if (!editor) return;
    const serialized = JSON.stringify(initial);
    if (serialized === lastValue.current) return;
    lastValue.current = serialized;
    setSnapshotError(false);
    editor.commands.setContent(initial.doc as JSONContent, { emitUpdate: false });
  }, [editor, initial]);

  function openDialog(nextMode: DialogMode) {
    if (!editor) return;
    previousMode.current = nextMode;
    const { from, to, $from } = editor.state.selection;
    selection.current = { from, to };
    setInvalidUrl(false); setUrl(String(editor.getAttributes('link').href ?? '')); setDetail('');
    setPosition('over'); setShape('dot'); setFill('filled');
    if (nextMode === 'ruby') {
      let rubyDepth = $from.depth;
      while (rubyDepth > 0 && $from.node(rubyDepth).type.name !== 'ruby') rubyDepth--;
      if (rubyDepth > 0) {
        const ruby = $from.node(rubyDepth);
        selection.current = { from: $from.before(rubyDepth), to: $from.after(rubyDepth), content: ruby.content.toJSON(), attrs: ruby.attrs, marks: ruby.toJSON().marks };
        setBaseText(ruby.textContent); setDetail(String(ruby.attrs.rt)); setPosition(String(ruby.attrs.position));
      } else {
        const slice = editor.state.doc.slice(from, to);
        const content = slice.content.toJSON()?.filter((node: JSONContent) => node.type === 'text') ?? [];
        selection.current.content = content;
        setBaseText(editor.state.doc.textBetween(from, to, ' '));
      }
    }
    if (nextMode === 'emphasis') {
      const attrs = editor.getAttributes('textEmphasis');
      setPosition(String(attrs.position ?? 'over')); setShape(String(attrs.shape ?? 'dot')); setFill(String(attrs.fill ?? 'filled'));
    }
    setMode(nextMode);
  }
  function apply(remove = false) {
    if (!editor || !mode) return;
    const range = selection.current;
    const chain = editor.chain().focus().setTextSelection(range);
    if (mode === 'link') {
      if (!remove && !safeDocumentUrl(url)) { setInvalidUrl(true); return; }
      if (remove || !url) chain.extendMarkRange('link').unsetLink().run();
      else if (range.from === range.to && !editor.isActive('link')) chain.insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] }).run();
      else chain.extendMarkRange('link').setLink({ href: url }).run();
    } else if (mode === 'image') {
      if (!safeDocumentUrl(url, true)) { setInvalidUrl(true); return; }
      chain.setImage({ src: url, alt: detail }).run();
    } else if (mode === 'ruby') {
      const preserved = range.content?.length && range.content.map(node => node.text ?? '').join('') === baseText ? range.content : [{ type: 'text', text: baseText }];
      const unwrapped = preserved.map(node => ({ ...node, marks: [...new Map([...(range.marks ?? []), ...(node.marks ?? [])].map(mark => [mark.type, mark])).values()] }));
      chain.insertContentAt(range, remove ? unwrapped : { type: 'ruby', attrs: { ...range.attrs, rt: detail, position }, content: preserved, ...(range.marks ? { marks: range.marks } : {}) }).run();
    } else if (remove) chain.unsetMark('textEmphasis').run();
    else chain.setMark('textEmphasis', { shape, fill, position }).run();
    setMode(null);
  }
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.altKey && event.key === 'F10' && editable) {
      event.preventDefault(); formatTriggerRef.current?.click(); return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && latest.current.onSave && !snapshotError) {
      event.preventDefault(); latest.current.onSave();
    }
  }
  return <div className={cn('min-w-0 rounded-2xl border border-border/60 bg-background', disabled && 'opacity-64', className)} data-slot="rich-text-editor" onKeyDown={keyboard}
    onCompositionEnd={() => { if (editor) requestAnimationFrame(() => { if (!editor.isDestroyed) publish(editor); }); }}>
    {editor && editable && toolbarMode === 'full' ? <Toolbar editor={editor} labels={labels} openDialog={openDialog} blocks={value.profile === 'blocks'} /> : null}
    {snapshotError ? <p role="alert" className="px-4 py-2 text-sm text-destructive">{labels.documentError}</p> : null}
    <div className={cn('relative px-4 py-3 sm:px-6', !compact && 'min-h-[50dvh]')}>
      {editor ? <>
        {editable ? <ContextFormatting editor={editor} labels={labels} openDialog={openDialog} blocks={value.profile === 'blocks'} triggerRef={formatTriggerRef}>
          <EditorContent editor={editor} className={cn('rezics-document', compact ? 'document-editor-compact' : 'document-editor')} />
        </ContextFormatting> : <EditorContent editor={editor} className={cn('rezics-document', compact ? 'document-editor-compact' : 'document-editor')} />}
        {editable ? <SelectionMenu editor={editor} labels={labels} openDialog={openDialog} /> : null}
        {editable && !compact ? <FloatingMenu editor={editor} options={{ placement: 'bottom-start' }}>
          <div className="flex gap-1 rounded-xl border border-border/60 bg-popover p-1 text-popover-foreground shadow-sm" role="group" aria-label={labels.insertBlock}>
            <Button size="sm" variant="ghost" onMouseDown={event => event.preventDefault()} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>{labels.heading2}</Button>
            <Button size="icon-sm" variant="ghost" aria-label={labels.bulletList} title={labels.bulletList} onMouseDown={event => event.preventDefault()} onClick={() => editor.chain().focus().toggleBulletList().run()}><ListIcon /></Button>
            {value.profile === 'blocks' ? <Button size="icon-sm" variant="ghost" aria-label={labels.table} title={labels.table} onMouseDown={event => event.preventDefault()} onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}><TableIcon /></Button> : null}
          </div>
        </FloatingMenu> : null}
      </> : <div role="status" aria-label={labels.loading}><SkeletonText lines={3} /></div>}
    </div>
    <Dialog open={mode !== null} onOpenChange={({ open }) => { if (!open) setMode(null); }}>
      <DialogContent showCloseButton={false} size="sm"><DialogHeader title={labels[mode ?? previousMode.current]} />
        <DialogBody><form id={fieldId} onSubmit={event => { event.preventDefault(); apply(); }}>
          <FieldGroup>
            {mode === 'link' || mode === 'image' ? <Field invalid={invalidUrl}><FieldLabel>{labels.url}</FieldLabel><Input value={url} autoFocus aria-invalid={invalidUrl} onChange={event => { setUrl(event.target.value); setInvalidUrl(false); }} />
              {invalidUrl ? <p role="alert" className="text-sm text-destructive">{labels.invalidUrl}</p> : null}</Field> : null}
            {mode === 'ruby' ? <Field><FieldLabel>{labels.baseText}</FieldLabel><Input value={baseText} autoFocus onChange={event => setBaseText(event.target.value)} /></Field> : null}
            {mode === 'image' || mode === 'ruby' ? <Field><FieldLabel>{mode === 'image' ? labels.imageAlt : labels.annotation}</FieldLabel><Input value={detail} onChange={event => setDetail(event.target.value)} /></Field> : null}
            {mode === 'ruby' || mode === 'emphasis' ? <Field><FieldLabel>{labels.position}</FieldLabel><NativeSelect value={position} onChange={event => setPosition(event.target.value)}>
              <NativeSelectOption value="over">{labels.over}</NativeSelectOption><NativeSelectOption value="under">{labels.under}</NativeSelectOption>
              {mode === 'ruby' ? <NativeSelectOption value="inter-character">{labels.interCharacter}</NativeSelectOption> : null}
            </NativeSelect></Field> : null}
            {mode === 'emphasis' ? <><Field><FieldLabel>{labels.shape}</FieldLabel><NativeSelect value={shape} onChange={event => setShape(event.target.value)}>
              {(['dot', 'sesame', 'circle', 'double-circle', 'triangle'] as const).map(value => <NativeSelectOption key={value} value={value}>{labels[value === 'double-circle' ? 'doubleCircle' : value]}</NativeSelectOption>)}
            </NativeSelect></Field><Field><FieldLabel>{labels.fill}</FieldLabel><NativeSelect value={fill} onChange={event => setFill(event.target.value)}><NativeSelectOption value="filled">{labels.filled}</NativeSelectOption><NativeSelectOption value="open">{labels.open}</NativeSelectOption></NativeSelect></Field></> : null}
          </FieldGroup>
        </form></DialogBody>
        <DialogFooter><Button variant="ghost" onClick={() => setMode(null)}>{labels.cancel}</Button>
          {mode !== 'image' ? <Button variant="outline" disabled={mode === 'ruby' && !baseText} onClick={() => apply(true)}>{labels.remove}</Button> : null}
          <Button type="submit" form={fieldId} disabled={mode === 'ruby' && !baseText}>{labels.apply}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}

'use client';

import { normalizeDocument, serializeDocument, withDocumentIds, type DocumentNode, type DocumentSnapshot } from '@rezics/document';
import { type Editor as TiptapEditor, type JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { EditorContent, useEditor } from '@tiptap/react';
import { UnlinkIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '../utils.ts';
import { Button } from './button.tsx';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from './dialog.tsx';
import { documentExtensions } from './document-extensions.tsx';
import { safeDocumentUrl } from './document-url.tsx';
import {
  alignCommands, availableCommands, blockCommands, commandById, describeCommand, historyCommands, markCommands, tableCommands, useCommandState,
  type CommandIO, type DialogMode, type EditorCommand,
} from './editor-commands.tsx';
import { richTextEditorLabels, type RichTextEditorLabels } from './editor-labels.tsx';
import { ImageInsert, imageFiles, uploadImagesAt, type ImageRequest, type ImageUploader } from './editor-image.tsx';
import { applyLink, LinkMenu, type LinkRange } from './editor-link.tsx';
import { SelectionMenu } from './editor-selection-menu.tsx';
import { idleSlashHandlers, SlashMenu, slashExtension } from './editor-slash-menu.tsx';
import { useCoarsePointer, type PointerMode } from './editor-surface.ts';
import { TouchBar } from './editor-touch-bar.tsx';
import { Field, FieldGroup, FieldLabel } from './field.tsx';
import { Input } from './input.tsx';
import { NativeSelect, NativeSelectOption } from './native-select.tsx';
import { SkeletonText } from './skeleton.tsx';

export { richTextEditorLabels, type RichTextEditorLabels };

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
  /** Which controls to offer. `auto` follows the device's primary input; stories and tests force one. */
  pointerMode?: PointerMode;
  /** Stores an image file and returns its address. Without it, images are embedded from links only. */
  onUploadImage?: ImageUploader;
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

type Selection = { from: number; to: number; content?: JSONContent[]; attrs?: JSONContent['attrs']; marks?: JSONContent['marks'] };

/**
 * The editor's document as a snapshot. ProseMirror keeps unchanged nodes between transactions, so
 * each top-level node's normalized block is remembered and a keystroke converts and checks only the
 * block it changed: typing costs the same in a one-line reply and in a long chapter.
 */
function snapshot(editor: TiptapEditor, profile: DocumentSnapshot['profile'], blocks: WeakMap<ProseMirrorNode, DocumentNode>): DocumentSnapshot {
  const nodes: ProseMirrorNode[] = [];
  const content: DocumentNode[] = [];
  editor.state.doc.forEach(node => { nodes.push(node); content.push(blocks.get(node) ?? node.toJSON() as DocumentNode); });
  let next: DocumentSnapshot;
  try {
    next = normalizeDocument({ version: 'rezics-document-v1', profile, doc: { type: 'doc', content } });
  } catch {
    // Identities are assigned within the same transaction; this repairs any node an extension left without one.
    next = normalizeDocument({ version: 'rezics-document-v1', profile, doc: withDocumentIds(editor.getJSON() as DocumentNode) });
  }
  nodes.forEach((node, index) => blocks.set(node, next.doc.content![index]!));
  return next;
}

function sameBlocks(a: DocumentSnapshot, b: DocumentSnapshot): boolean {
  const left = a.doc.content ?? [], right = b.doc.content ?? [];
  return a === b || (a.profile === b.profile && left.length === right.length && left.every((block, index) => block === right[index]));
}

/** Normalized blocks serialize from cache, so comparing a returned value with the last emitted one costs only what changed. */
function sameDocument(a: DocumentSnapshot, b: DocumentSnapshot): boolean {
  return sameBlocks(a, b) || serializeDocument(a) === serializeDocument(b);
}

function normalizeValue(value: DocumentSnapshot): DocumentSnapshot {
  try {
    return normalizeDocument(value);
  } catch {
    return normalizeDocument({ ...value, doc: withDocumentIds(value.doc) });
  }
}

/** The full toolbar of Studio's advanced mode. Every control comes from the command table the contextual surfaces use. */
function Toolbar({ editor, labels, io, blocks }: { editor: TiptapEditor; labels: RichTextEditorLabels; io: CommandIO; blocks: boolean }) {
  const state = useCommandState(editor);
  const button = (command: EditorCommand) => <Button key={command.id} size="icon-sm" variant={state.isActive(command.id) ? 'soft' : 'ghost'} aria-label={labels[command.label]}
    title={describeCommand(command, labels)} aria-pressed={command.active ? state.isActive(command.id) : undefined} disabled={state.isDisabled(command.id)}
    onMouseDown={event => event.preventDefault()} onClick={() => command.run(editor, io)}><command.icon aria-hidden="true" /></Button>;
  const text = (command: EditorCommand) => <Button key={command.id} size="sm" variant="ghost" disabled={state.isDisabled(command.id)}
    onMouseDown={event => event.preventDefault()} onClick={() => command.run(editor, io)}>{labels[command.label]}</Button>;
  const ids = (list: string[]) => list.map(commandById);
  const align = alignCommands.find(command => state.isActive(command.id))?.id ?? 'align-left';
  return <div role="group" aria-label={labels.toolbar} className="flex flex-wrap items-center gap-1 border-b border-border/60 p-2" data-slot="editor-toolbar">
    <Field className="w-auto"><NativeSelect aria-label={labels.blockType} size="sm" value={state.block} onChange={event => commandById(event.target.value).run(editor, io)}>
      {availableCommands(blockCommands, blocks).map(command => <NativeSelectOption key={command.id} value={command.id}>{labels[command.label]}</NativeSelectOption>)}
    </NativeSelect></Field>
    {markCommands.map(button)}
    {ids(['link']).map(button)}
    {state.isActive('link') ? <Button size="icon-sm" variant="ghost" aria-label={labels.unlink} title={labels.unlink} onMouseDown={event => event.preventDefault()}
      onClick={() => { editor.chain().focus().extendMarkRange('link').unsetLink().run(); }}><UnlinkIcon aria-hidden="true" /></Button> : null}
    {ids(['bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock']).map(button)}
    <Field className="w-auto"><NativeSelect aria-label={labels.alignment} size="sm" value={align} onChange={event => commandById(event.target.value).run(editor, io)}>
      {alignCommands.map(command => <NativeSelectOption key={command.id} value={command.id}>{labels[command.label]}</NativeSelectOption>)}
    </NativeSelect></Field>
    {ids(['ruby', 'emphasis']).map(text)}
    {button(commandById('clearFormatting'))}
    {availableCommands(ids(['table', 'image', 'horizontalRule']), blocks).map(button)}
    {historyCommands.map(button)}
    {blocks && state.inTable ? <div role="group" aria-label={labels.table} className="flex w-full flex-wrap gap-1 border-t border-border/60 pt-2">
      {tableCommands.map(command => <Button key={command.id} size="sm" variant="ghost" onMouseDown={event => event.preventDefault()} onClick={() => command.run(editor, io)}>{labels[command.label]}</Button>)}
    </div> : null}
  </div>;
}

/** A controlled Tiptap document editor. Initial hydration and controlled value updates never save a document. */
export function RichTextEditor({ value, onChange, label, labels: labelOverrides, placeholder, lang, dir, className, compact = false, toolbarMode = 'contextual', pointerMode = 'auto', onUploadImage,
  disabled = false, readOnly = false, autoFocus = false, maxLength, onBlur, onFocus, onSave, onKeyDown, onSnapshotError }: RichTextEditorProps) {
  const labels = useMemo(() => ({ ...richTextEditorLabels, ...labelOverrides }), [labelOverrides]);
  const lastEmitted = useRef<DocumentSnapshot | null>(null);
  // A value the editor emitted comes back unchanged through its owner; it is already normalized.
  const initial = useMemo(() => value === lastEmitted.current ? value : normalizeValue(value), [value]);
  lastEmitted.current ??= initial;
  const blockCache = useRef(new WeakMap<ProseMirrorNode, DocumentNode>());
  const latest = useRef({ onChange, onBlur, onFocus, onSave, onSnapshotError, profile: value.profile });
  latest.current = { onChange, onBlur, onFocus, onSave, onSnapshotError, profile: value.profile };
  const editable = !disabled && !readOnly;
  const coarse = useCoarsePointer(pointerMode);
  const blocks = value.profile === 'blocks';
  const slashEnabled = editable && !compact;
  const fieldId = useId();
  const slashHandlers = useRef(idleSlashHandlers);
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
  const [linkRange, setLinkRange] = useState<LinkRange | null>(null);
  const [imageRequest, setImageRequest] = useState<ImageRequest | null>(null);
  const [uploads, setUploads] = useState(0);
  const [uploadFailed, setUploadFailed] = useState(false);
  const uploader = useRef(onUploadImage);
  uploader.current = onUploadImage;
  const selection = useRef<Selection>({ from: 0, to: 0 });
  const extensions = useMemo(() => [
    ...documentExtensions({ placeholder, emptyLineHint: slashEnabled ? labels.slashHint : undefined, unknownComponentLabel: labels.unknownComponent, maxLength, blocks }),
    ...(slashEnabled ? [slashExtension(slashHandlers)] : []),
  ], [placeholder, slashEnabled, labels.slashHint, labels.unknownComponent, maxLength, blocks]);
  function publish(current: TiptapEditor) {
    if (current.view.composing) return;
    try {
      const next = snapshot(current, latest.current.profile, blockCache.current);
      setSnapshotError(false);
      if (lastEmitted.current && sameBlocks(next, lastEmitted.current)) return;
      lastEmitted.current = next;
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
      handlePaste: (view, event) => {
        const files = imageFiles(event.clipboardData?.files);
        if (!files.length || !uploader.current || !blocks) return false;
        event.preventDefault();
        view.dispatch(view.state.tr.deleteSelection());
        startUploads(files, view.state.selection.from);
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        const files = imageFiles(event.dataTransfer?.files);
        if (moved || !files.length || !uploader.current || !blocks) return false;
        event.preventDefault();
        startUploads(files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from);
        return true;
      },
    },
  }, [value.profile]);
  const editorRef = useRef(editor);
  editorRef.current = editor;
  // With dependencies, Tiptap never reapplies options after creation; the view's attributes follow the props here.
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editable, false);
    editor.setOptions({ editorProps: { ...editor.options.editorProps,
      // The keyboard toolbar rests over the bottom of the screen, so the caret must scroll clear of it.
      ...(coarse ? { scrollMargin: { top: 8, right: 8, bottom: 72, left: 8 }, scrollThreshold: { top: 8, right: 8, bottom: 72, left: 8 } } : { scrollMargin: 5, scrollThreshold: 0 }),
      attributes: { role: 'textbox', 'aria-label': label, 'aria-multiline': 'true', 'aria-readonly': String(readOnly), 'aria-disabled': String(disabled), spellcheck: 'true', ...(lang ? { lang } : {}), ...(dir ? { dir } : {}) },
    } });
  }, [editor, editable, coarse, label, readOnly, disabled, lang, dir]);
  function startUploads(files: File[], position: number) {
    const current = editorRef.current, upload = uploader.current;
    if (!current || !upload) return;
    setUploads(count => count + 1); setUploadFailed(false);
    void uploadImagesAt(current, files, position, upload).then(ok => { setUploads(count => count - 1); if (!ok) setUploadFailed(true); });
  }
  useEffect(() => {
    if (!editor) return;
    if (lastEmitted.current && sameDocument(initial, lastEmitted.current)) return;
    lastEmitted.current = initial;
    setSnapshotError(false);
    editor.commands.setContent(initial.doc as JSONContent, { emitUpdate: false });
  }, [editor, initial]);
  // An open link field belongs to the selection it was opened on.
  useEffect(() => {
    if (!editor) return;
    const follow = () => setLinkRange(range => range && (range.from !== editor.state.selection.from || range.to !== editor.state.selection.to) ? null : range);
    editor.on('selectionUpdate', follow);
    return () => { editor.off('selectionUpdate', follow); };
  }, [editor]);

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
  /** A link on selected text, or on a link under the caret, is edited where it is; anything else asks in a dialog. */
  function openLink() {
    if (!editor) return;
    const { from, to, empty } = editor.state.selection;
    if ((!coarse && !empty) || (empty && editor.isActive('link'))) setLinkRange({ from, to });
    else openDialog('link');
  }
  function openImage() {
    if (!editor) return;
    const { from } = editor.state.selection;
    const caret = editor.view.coordsAtPos(from);
    setImageRequest({ position: from, caret: new DOMRect(caret.left, caret.top, 0, caret.bottom - caret.top) });
  }
  // Surfaces receive one stable object, so a keystroke that re-renders the editor does not re-render them.
  const actions = useRef({ openDialog, openLink, openImage });
  actions.current = { openDialog, openLink, openImage };
  const io = useMemo<CommandIO>(() => ({
    openDialog: mode => actions.current.openDialog(mode), openLink: () => actions.current.openLink(), openImage: () => actions.current.openImage(),
  }), []);
  const closeLink = useCallback(() => setLinkRange(null), []);
  const editLink = useCallback(() => actions.current.openLink(), []);
  const closeImage = useCallback(() => { setImageRequest(null); editor?.commands.focus(); }, [editor]);
  function apply(remove = false) {
    if (!editor || !mode) return;
    const range = selection.current;
    if (mode === 'link') {
      if (!remove && !safeDocumentUrl(url)) { setInvalidUrl(true); return; }
      applyLink(editor, range, remove || !url ? null : url);
      setMode(null);
      return;
    }
    const chain = editor.chain().focus().setTextSelection(range);
    if (mode === 'ruby') {
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
    // Alt+F10 moves focus into the selection panel, the conventional way to reach an editor's toolbar.
    if (event.altKey && event.key === 'F10' && editable) {
      const first = event.currentTarget.querySelector<HTMLButtonElement>('[data-slot="editor-selection-menu"] button:not([disabled])');
      if (first) { event.preventDefault(); first.focus(); }
      return;
    }
    const modifier = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
    if (modifier && event.key.toLowerCase() === 'k' && editable) {
      event.preventDefault(); openLink(); return;
    }
    if (modifier && event.key.toLowerCase() === 's' && latest.current.onSave && !snapshotError) {
      event.preventDefault(); latest.current.onSave();
    }
  }
  const content = editor ? <EditorContent editor={editor} className={cn('rezics-document', compact ? 'document-editor-compact' : 'document-editor')} /> : null;
  return <div className={cn('min-w-0 rounded-2xl border border-border/60 bg-background', disabled && 'opacity-64', className)} data-slot="rich-text-editor" data-pointer={coarse ? 'coarse' : 'fine'} onKeyDown={keyboard}
    onCompositionEnd={() => { if (editor) requestAnimationFrame(() => { if (!editor.isDestroyed) publish(editor); }); }}>
    {editor && editable && toolbarMode === 'full' ? <Toolbar editor={editor} labels={labels} io={io} blocks={blocks} /> : null}
    {snapshotError ? <p role="alert" className="px-4 py-2 text-sm text-destructive">{labels.documentError}</p> : null}
    {uploadFailed ? <p role="alert" className="px-4 py-2 text-sm text-destructive">{labels.uploadFailed}</p> : null}
    {uploads ? <p role="status" className="px-4 py-2 text-sm text-muted-foreground">{labels.uploading}</p> : null}
    <div className={cn('relative px-4 py-3 sm:px-6', !compact && 'min-h-[50dvh]')}>
      {editor ? <>
        {content}
        {editable ? <>
          {!coarse ? <SelectionMenu editor={editor} labels={labels} blocks={blocks} io={io} linkRange={linkRange} onLinkClose={closeLink} /> : null}
          <LinkMenu editor={editor} labels={labels} linkRange={linkRange} onEdit={editLink} onClose={closeLink} />
          {coarse ? <TouchBar editor={editor} labels={labels} blocks={blocks} compact={compact} io={io} /> : null}
          {slashEnabled ? <SlashMenu editor={editor} labels={labels} blocks={blocks} io={io} handlers={slashHandlers} /> : null}
          {imageRequest ? <ImageInsert editor={editor} labels={labels} request={imageRequest} upload={onUploadImage} onClose={closeImage} /> : null}
        </> : null}
      </> : <div role="status" aria-label={labels.loading}><SkeletonText lines={3} /></div>}
    </div>
    <Dialog open={mode !== null} onOpenChange={({ open }) => { if (!open) setMode(null); }}>
      <DialogContent showCloseButton={false} size="sm"><DialogHeader title={labels[mode ?? previousMode.current]} />
        <DialogBody><form id={fieldId} onSubmit={event => { event.preventDefault(); apply(); }}>
          <FieldGroup>
            {mode === 'link' ? <Field invalid={invalidUrl}><FieldLabel>{labels.url}</FieldLabel><Input value={url} autoFocus aria-invalid={invalidUrl} onChange={event => { setUrl(event.target.value); setInvalidUrl(false); }} />
              {invalidUrl ? <p role="alert" className="text-sm text-destructive">{labels.invalidUrl}</p> : null}</Field> : null}
            {mode === 'ruby' ? <Field><FieldLabel>{labels.baseText}</FieldLabel><Input value={baseText} autoFocus onChange={event => setBaseText(event.target.value)} /></Field> : null}
            {mode === 'ruby' ? <Field><FieldLabel>{labels.annotation}</FieldLabel><Input value={detail} onChange={event => setDetail(event.target.value)} /></Field> : null}
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
          <Button variant="outline" disabled={mode === 'ruby' && !baseText} onClick={() => apply(true)}>{labels.remove}</Button>
          <Button type="submit" form={fieldId} disabled={mode === 'ruby' && !baseText}>{labels.apply}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}

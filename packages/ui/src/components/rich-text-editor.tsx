'use client';

import { normalizeDocument, withDocumentIds, type DocumentNode, type DocumentSnapshot } from '@rezics/document';
import { type Editor as TiptapEditor, type JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { ImageIcon, UnlinkIcon } from 'lucide-react';
import { memo, useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { cn } from '../utils.ts';
import { Button } from './button.tsx';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from './dialog.tsx';
import { documentExtensions } from './document-extensions.tsx';
import { safeDocumentUrl } from './document-url.tsx';
import {
  alignCommands, availableCommands, BlockActionShortcuts, blockCommands, commandById, describeCommand, historyCommands, markCommands, tableCommands, useCommandState,
  type CommandIO, type DialogMode, type EditorCommand,
} from './editor-commands.tsx';
import { richTextEditorLabels, type RichTextEditorLabels } from './editor-labels.tsx';
import { ImageInsert, imageFiles, uploadImagesAt, type ImageRequest, type ImageUploader } from './editor-image.tsx';
import type { ImageLabelEditor } from './editor-image-view.tsx';
import { ImageAuthoringScope, type ImageMetadataResolver } from './media-image.tsx';
import { applyLink, LinkMenu, type LinkRange } from './editor-link.tsx';
import { SelectionMenu } from './editor-selection-menu.tsx';
import { idleSlashHandlers, SlashMenu, slashExtension } from './editor-slash-menu.tsx';
import { useCoarsePointer, type PointerMode } from './editor-surface.ts';
import { TouchBar } from './editor-touch-bar.tsx';
import { Field, FieldGroup, FieldLabel } from './field.tsx';
import { Input } from './input.tsx';
import { NativeSelect, NativeSelectOption } from './native-select.tsx';
import { SkeletonText } from './skeleton.tsx';
import { editorSnapshot } from './rich-text-editor-snapshot.ts';
import { editorUploads } from './rich-text-editor-uploads.ts';
import { controlledEditorContent, removeEditorImages, sameEditorBlocks } from './rich-text-editor-recovery.tsx';

export { richTextEditorLabels, type RichTextEditorLabels };

export interface RichTextEditorRecovery {
  document: () => DocumentNode | undefined;
  text: () => string | undefined;
  focus: () => void;
  retrySnapshot: () => void;
  retryUploads: () => void;
  cancelUploads: () => void;
  removeImages: (invalidOnly?: boolean) => void;
}

export interface RichTextEditorProps {
  value: DocumentSnapshot;
  /** Raw editor-owned recovery takes precedence until its complete snapshot can be persisted. */
  recoveryDocument?: DocumentNode;
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
  /**
   * Disabled by default: discussion writing on a phone used to show its formats on a bar resting on
   * the keyboard. It now uses the selection bar on every device; this keeps the keyboard bar
   * available for comparison on real phones.
   */
  discussionKeyboardBar?: boolean;
  /** Stores an image file and returns its address. Without it, images are embedded from links only. */
  onUploadImage?: ImageUploader;
  onEditImageLabels?: ImageLabelEditor;
  resolveImageMetadata?: ImageMetadataResolver;
  imageMetadataScope?: string;
  disabled?: boolean;
  readOnly?: boolean;
  autoFocus?: boolean;
  maxLength?: number;
  onBlur?: () => void;
  onFocus?: () => void;
  onSave?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onSnapshotError?: (error: unknown) => void;
  onSnapshotPending?: () => void;
  onUploadStateChange?: (state: 'pending' | 'ready' | 'failed') => void;
  recoveryRef?: Ref<RichTextEditorRecovery>;
}

type Selection = { from: number; to: number; content?: JSONContent[]; attrs?: JSONContent['attrs']; marks?: JSONContent['marks'] };

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

/**
 * What discussion writing keeps in view, like a chat app's attach button: inserting an image. It
 * shows while the writer is in the field or it has content, so an idle reply box stays one line.
 * Formatting appears only on a selection.
 */
const ComposeActions = memo(function ComposeActions({ editor, labels, io }: { editor: TiptapEditor; labels: RichTextEditorLabels; io: CommandIO }) {
  const shown = useEditorState({ editor, selector: ({ editor: current }) => current.isFocused || !current.isEmpty });
  if (!shown) return null;
  return <div className="mt-1 flex items-center gap-1" data-slot="editor-compose-actions">
    <Button type="button" size="icon-sm" variant="ghost" aria-label={labels.image} title={labels.image} onMouseDown={event => event.preventDefault()}
      onClick={() => { editor.chain().focus().run(); io.openImage(); }}><ImageIcon aria-hidden="true" /></Button>
  </div>;
});

/** A controlled Tiptap document editor. Initial hydration and controlled value updates never save a document. */
export function RichTextEditor({ value, recoveryDocument, onChange, label, labels: labelOverrides, placeholder, lang, dir, className, compact = false, toolbarMode = 'contextual', pointerMode = 'auto', discussionKeyboardBar = false, onUploadImage, onEditImageLabels, resolveImageMetadata, imageMetadataScope,
  disabled = false, readOnly = false, autoFocus = false, maxLength, onBlur, onFocus, onSave, onKeyDown, onSnapshotError, onSnapshotPending, onUploadStateChange, recoveryRef }: RichTextEditorProps) {
  const labels = useMemo(() => ({ ...richTextEditorLabels, ...labelOverrides }), [labelOverrides]);
  const lastEmitted = useRef<DocumentSnapshot | null>(null);
  // A value the editor emitted comes back unchanged through its owner; it is already normalized.
  const initial = useMemo(() => value === lastEmitted.current ? value : normalizeValue(value), [value]);
  lastEmitted.current ??= initial;
  const blockCache = useRef(new WeakMap<ProseMirrorNode, DocumentNode>());
  const latest = useRef({ onChange, onBlur, onFocus, onSave, onSnapshotError, onSnapshotPending, onUploadStateChange, profile: value.profile });
  latest.current = { onChange, onBlur, onFocus, onSave, onSnapshotError, onSnapshotPending, onUploadStateChange, profile: value.profile };
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
  const uploadRecovery = useMemo(() => editorUploads((state, count) => {
    setUploads(count); setUploadFailed(state === 'failed');
    latest.current.onUploadStateChange?.(state);
  }), []);
  const uploader = useRef(onUploadImage);
  uploader.current = onUploadImage;
  const imageLabelsEditor = useRef(onEditImageLabels);
  imageLabelsEditor.current = onEditImageLabels;
  const editImageLabels = useMemo<ImageLabelEditor>(() => change => {
    const edit = imageLabelsEditor.current;
    if (!edit) return Promise.reject(new Error('image-label-editor-unavailable'));
    return edit(change);
  }, []);
  const selection = useRef<Selection>({ from: 0, to: 0 });
  const extensions = useMemo(() => [
    ...documentExtensions({ placeholder, emptyLineHint: slashEnabled ? labels.slashHint : undefined, unknownComponentLabel: labels.unknownComponent, maxLength, blocks, onEditImageLabels: onEditImageLabels ? editImageLabels : undefined }),
    BlockActionShortcuts,
    ...(slashEnabled ? [slashExtension(slashHandlers)] : []),
  ], [placeholder, slashEnabled, labels.slashHint, labels.unknownComponent, maxLength, blocks, onEditImageLabels, editImageLabels]);
  function publish(current: TiptapEditor, force = false) {
    if (current.view.composing) return;
    try {
      const next = editorSnapshot(current.state.doc, latest.current.profile, blockCache.current);
      setSnapshotError(false);
      if (!force && lastEmitted.current && sameEditorBlocks(next, lastEmitted.current)) return;
      latest.current.onSnapshotPending?.();
      lastEmitted.current = next;
      latest.current.onChange(next);
    } catch (error) {
      setSnapshotError(true);
      latest.current.onSnapshotError?.(error);
    } finally {
      uploadRecovery.snapshot(current.state.doc);
    }
  }
  const editor = useEditor({
    extensions, content: (recoveryDocument ?? initial.doc) as JSONContent, immediatelyRender: false, shouldRerenderOnTransaction: false,
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
  const surface = useRef<HTMLDivElement>(null);
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const trackedUpload = useMemo<ImageUploader>(() => async (file, occurrence) => {
    const upload = uploader.current;
    if (!upload) throw new Error('image-upload-unavailable');
    const position = editorRef.current?.state.selection.from ?? 0;
    uploadRecovery.start(occurrence, file, position);
    try {
      const image = await upload(file, occurrence);
      if (!safeDocumentUrl(image.src, true)) throw new Error('image-address-unavailable');
      uploadRecovery.stored(occurrence);
      return image;
    } catch (error) {
      uploadRecovery.failed(occurrence);
      throw error;
    }
  }, [uploadRecovery]);
  useImperativeHandle(recoveryRef, () => ({
    document: () => editor?.getJSON() as DocumentNode | undefined,
    text: () => editor?.getText(),
    focus: () => { if (editor && editable) editor.view.focus(); },
    retrySnapshot: () => { if (editor) publish(editor, true); },
    retryUploads: () => {
      if (!editor || !editable) return;
      const pending = uploadRecovery.takeFailures();
      for (const { file, position } of pending) void uploadImagesAt(editor, [file], position, trackedUpload);
    },
    cancelUploads: () => {
      uploadRecovery.takeFailures();
      if (editor) publish(editor, true);
    },
    removeImages: (invalidOnly = false) => {
      if (!editor || !editable) return;
      editor.view.dispatch(removeEditorImages(editor.state, invalidOnly));
      publish(editor, true);
    },
  }));
  // With dependencies, Tiptap never reapplies options after creation; the view's attributes follow the props here.
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editable, false);
    editor.setOptions({ editorProps: { ...editor.options.editorProps,
      // The keyboard toolbar rests over the bottom of the screen, so the caret must scroll clear of it.
      ...(coarse ? { scrollMargin: { top: 8, right: 8, bottom: 72, left: 8 }, scrollThreshold: { top: 8, right: 8, bottom: 72, left: 8 } } : { scrollMargin: 5, scrollThreshold: 0 }),
      attributes: { role: 'textbox', 'aria-label': label, 'aria-multiline': 'true', 'aria-readonly': String(readOnly), 'aria-disabled': String(disabled), spellcheck: 'true', ...(lang ? { lang } : {}), ...(dir ? { dir } : {}) },
    } });
  }, [editor, editable, coarse, label, readOnly, disabled, lang, dir, onEditImageLabels]);
  function startUploads(files: File[], position: number) {
    const current = editorRef.current, upload = uploader.current;
    if (!current || !upload) return;
    void uploadImagesAt(current, files, position, trackedUpload);
  }
  useEffect(() => {
    if (!editor) return;
    const content = controlledEditorContent(initial, lastEmitted.current, editor.state.doc, recoveryDocument);
    if (!content) return;
    if (!recoveryDocument) {
      lastEmitted.current = initial;
      setSnapshotError(false);
    }
    editor.commands.setContent(content as JSONContent, { emitUpdate: false });
  }, [editor, initial, recoveryDocument]);
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
  const rendered = <div className={cn('min-w-0 rounded-2xl border border-border/60 bg-background', disabled && 'opacity-64', className)} data-slot="rich-text-editor" data-pointer={coarse ? 'coarse' : 'fine'} onKeyDown={keyboard}
    onCompositionEnd={() => { if (editor) requestAnimationFrame(() => { if (!editor.isDestroyed) publish(editor); }); }}>
    {/* A row of every control fits a pointer's screen; a phone keeps its keyboard toolbar. */}
    {editor && editable && toolbarMode === 'full' && !coarse ? <Toolbar editor={editor} labels={labels} io={io} blocks={blocks} /> : null}
    {snapshotError ? <p role="alert" className="px-4 py-2 text-sm text-destructive-foreground">{labels.documentError}</p> : null}
    {uploadFailed ? <p role="alert" className="px-4 py-2 text-sm text-destructive-foreground">{labels.uploadFailed}</p> : null}
    {uploads ? <p role="status" className="px-4 py-2 text-sm text-muted-foreground">{labels.uploading}</p> : null}
    <div ref={surface} className={cn('relative px-4 py-3 sm:px-6', !compact && 'min-h-[50dvh]')}>
      {editor ? <>
        {content}
        {editable ? <>
          {/* Discussion writing selects and formats the same way on every device; long-form writing on a phone uses the keyboard toolbar. */}
          {!coarse || (compact && !discussionKeyboardBar) ? <SelectionMenu editor={editor} labels={labels} blocks={blocks} io={io} linkRange={linkRange} onLinkClose={closeLink} container={surface} compose={compact} below={coarse} /> : null}
          <LinkMenu editor={editor} labels={labels} linkRange={linkRange} onEdit={editLink} onClose={closeLink} container={surface} />
          {compact && blocks ? <ComposeActions editor={editor} labels={labels} io={io} /> : null}
          {coarse && (!compact || discussionKeyboardBar) ? <TouchBar editor={editor} labels={labels} blocks={blocks} compact={compact} io={io} /> : null}
          {slashEnabled ? <SlashMenu editor={editor} labels={labels} blocks={blocks} io={io} handlers={slashHandlers} /> : null}
          {imageRequest ? <ImageInsert editor={editor} labels={labels} request={imageRequest} upload={onUploadImage ? trackedUpload : undefined} onClose={closeImage} /> : null}
        </> : null}
      </> : <div role="status" aria-label={labels.loading}><SkeletonText lines={3} /></div>}
    </div>
    <Dialog open={mode !== null} onOpenChange={({ open }) => { if (!open) setMode(null); }}>
      <DialogContent showCloseButton={false} size="sm"><DialogHeader title={labels[mode ?? previousMode.current]} />
        <DialogBody><form id={fieldId} onSubmit={event => { event.preventDefault(); apply(); }}>
          <FieldGroup>
            {mode === 'link' ? <Field invalid={invalidUrl}><FieldLabel>{labels.url}</FieldLabel><Input value={url} autoFocus aria-invalid={invalidUrl} onChange={event => { setUrl(event.target.value); setInvalidUrl(false); }} />
              {invalidUrl ? <p role="alert" className="text-sm text-destructive-foreground">{labels.invalidUrl}</p> : null}</Field> : null}
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
  return resolveImageMetadata ? <ImageAuthoringScope resolve={resolveImageMetadata} scope={imageMetadataScope}>{rendered}</ImageAuthoringScope> : rendered;
}

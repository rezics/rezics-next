'use client';

import { Button } from '@rezics/ui/shadcn/button';
import {
  documentVersion,
  normalizeDocument,
  withDocumentIds,
  type DocumentNode,
  type DocumentSnapshot,
} from '@rezics/document';
import { Extension, type Editor as TiptapEditor, type JSONContent } from '@tiptap/core';
import { history } from '@tiptap/pm/history';
import { useEditor } from '@tiptap/react';
import { ImageIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../utils.ts';
import { EditorSurface, editorAttributes, editorExtensions, sanitizePastedHTML } from './editor-surface.ts';
import { assertSnapshotSize, editorSnapshot } from './rich-text-editor-snapshot.ts';

import { richTextEditorLabels, type RichTextEditorLabels } from './editor-labels.ts';
import { SelectionMenu } from './editor-selection-menu.tsx';
import { EditorTouchBar } from './editor-touch-bar.tsx';
import { LinkMenu, type LinkRange } from './editor-link.tsx';
import { ImageInsert, withImageView } from './editor-image.tsx';
import { editorUploads, type ImageUploader, type UploadEntry, type UploadState } from './editor-uploads.ts';
import { availableCommands, imageCommand } from './editor-commands.ts';
import { idleSlashHandlers, SlashMenu, slashExtension } from './editor-slash-menu.tsx';

import {
  idleMentionHandlers,
  mentionExtension,
  MentionMenu,
  withMentionView,
  type MentionSource,
} from './editor-mention.tsx';

export type { ImageUploader, UploadedImage, UploadState } from './editor-uploads.ts';
export type { RichTextEditorLabels } from './editor-labels.ts';

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
  disabled?: boolean;
  readOnly?: boolean;
  autoFocus?: boolean;
  toolbar?: 'auto' | 'always' | 'never';
  maxLength?: number;
  upload?: ImageUploader;
  lookupMention?: MentionSource;
  onUploadState?: (state: UploadState, count: number) => void;
  /** Rendered at the end of the row that starts with the image control. */
  actions?: ReactNode;
  onBlur?: () => void;
  onFocus?: () => void;
  onSave?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
}

const EditorHistory = Extension.create({
  name: 'editorHistory',
  addProseMirrorPlugins: () => [history()],
});

function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(pointer: coarse)');
    const update = () => setCoarse(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return coarse;
}

function useEditorFocus(editor: TiptapEditor | null): boolean {
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!editor) {
      setFocused(false);
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const focus = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      setFocused(true);
    };
    const blur = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        setFocused(false);
      }, 150);
    };

    setFocused(editor.isFocused);
    editor.on('focus', focus);
    editor.on('blur', blur);
    return () => {
      if (timer !== null) clearTimeout(timer);
      editor.off('focus', focus);
      editor.off('blur', blur);
    };
  }, [editor]);

  return focused;
}

function normalizeEditorValue(value: DocumentSnapshot): DocumentSnapshot {
  try {
    return normalizeDocument(value);
  } catch {
    return normalizeDocument({
      version: documentVersion,
      profile: value.profile,
      doc: withDocumentIds(value.doc as DocumentNode),
    });
  }
}

/** Controlled editor for snapshots in the text and blocks document profiles. */
export function RichTextEditor({
  value,
  onChange,
  label,
  labels,
  placeholder,
  lang,
  dir,
  className,
  compact = false,
  disabled = false,
  readOnly = false,
  autoFocus = false,
  toolbar = 'auto',
  maxLength,
  upload,
  onUploadState,
  lookupMention,
  actions,
  onBlur,
  onFocus,
  onSave,
  onKeyDown,
}: RichTextEditorProps) {
  const normalizedValue = useMemo(() => {
    const snapshot = normalizeEditorValue(value);
    assertSnapshotSize(snapshot);
    return snapshot;
  }, [value]);
  const latest = useRef({ onChange, onBlur, onFocus, onSave, onKeyDown, onUploadState, upload });
  latest.current = { onChange, onBlur, onFocus, onSave, onKeyDown, onUploadState, upload };

  const emitted = useRef<DocumentSnapshot | null>(null);
  const lastProp = useRef(value);
  const lastPublishedDoc = useRef<TiptapEditor['state']['doc'] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const publishRef = useRef<(editor: TiptapEditor) => void>(() => undefined);
  const [snapshotError, setSnapshotError] = useState(false);
  const editable = !disabled && !readOnly;
  const hasUpload = !!upload;
  const menuContainer = useRef<HTMLDivElement>(null);
  const [linkRange, setLinkRange] = useState<LinkRange | null>(null);
  const [imagePosition, setImagePosition] = useState<number | null>(null);
  const [uploadEntries, setUploadEntries] = useState<UploadEntry[]>([]);
  const [uploadMessage, setUploadMessage] = useState('');
  const [touchSheetOpen, setTouchSheetOpen] = useState(false);
  const uploads = useRef<ReturnType<typeof editorUploads> | null>(null);
  const resolvedLabels = useMemo(() => ({ ...richTextEditorLabels, ...labels }), [labels]);

  const labelsRef = useRef(resolvedLabels);
  labelsRef.current = resolvedLabels;
  const slashHandlers = useRef(idleSlashHandlers);
  const mentionHandlers = useRef(idleMentionHandlers);
  const mentionEnabled = useRef(!!lookupMention);
  mentionEnabled.current = !!lookupMention;
  const mentionHandles = useRef(new Map<string, string>());

  const publish = useCallback(
    (editor: TiptapEditor) => {
      if (editor.isDestroyed || editor.view.composing || lastPublishedDoc.current === editor.state.doc) return;

      let snapshot: DocumentSnapshot;
      try {
        snapshot = editorSnapshot(editor.state.doc, value.profile);
      } catch {
        setSnapshotError(true);
        return;
      }

      setSnapshotError(false);
      emitted.current = snapshot;
      lastPublishedDoc.current = editor.state.doc;
      latest.current.onChange(snapshot);
      uploads.current?.snapshot(editor.state.doc);
    },
    [value.profile],
  );
  publishRef.current = publish;

  const schedulePublish = useCallback((editor: TiptapEditor) => {
    if (editor.isDestroyed || editor.view.composing) return;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      publishRef.current(editor);
    }, 150);
  }, []);

  const flushPublish = useCallback((editor: TiptapEditor) => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    publishRef.current(editor);
  }, []);

  const scheduleRef = useRef(schedulePublish);
  scheduleRef.current = schedulePublish;
  const flushRef = useRef(flushPublish);
  flushRef.current = flushPublish;

  const editor = useEditor(
    {
      extensions: [
        EditorHistory,
        ...withMentionView(
          withImageView(
            editorExtensions(value.profile, {
              ...(placeholder === undefined ? {} : { placeholder }),
              ...(maxLength === undefined ? {} : { maxLength }),
            }),
            () => labelsRef.current,
          ),
          mentionHandles,
        ),
        slashExtension(slashHandlers),
        mentionExtension(mentionHandlers, mentionEnabled),
      ],
      content: normalizedValue.doc as JSONContent,
      injectCSS: false,
      immediatelyRender: false,
      shouldRerenderOnTransaction: false,
      autofocus: autoFocus,
      editable,
      enableContentCheck: true,
      editorProps: {
        attributes: editorAttributes({
          label,
          ...(lang === undefined ? {} : { lang }),
          ...(dir === undefined ? {} : { dir }),
          disabled,
          readOnly,
        }),
        transformPastedHTML: sanitizePastedHTML,
        handlePaste: (view, event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (!files.length) return false;
          if (view.editable) uploads.current?.add(files, view.state.selection.from);
          return true;
        },
        handleDrop: (view, event, _slice, moved) => {
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (moved || !files.length) return false;
          const position =
            view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from;
          if (view.editable) uploads.current?.add(files, position);
          return true;
        },
      },
      onUpdate: ({ editor: current }) => scheduleRef.current(current),
      onBlur: ({ editor: current }) => {
        flushRef.current(current);
        latest.current.onBlur?.();
      },
      onFocus: () => latest.current.onFocus?.(),
    },
    [value.profile, placeholder, maxLength],
  );

  useEffect(() => {
    latest.current.onUploadState?.('ready', 0);
    if (!editor || !hasUpload || !editor.schema.nodes.image) return;
    const manager = editorUploads(
      editor,
      value.profile,
      (file, signal) => latest.current.upload!(file, signal),
      (state, count, entries) => {
        setUploadEntries(entries);
        latest.current.onUploadState?.(state, count);
      },
      () => flushRef.current(editor),
      (reason) => setUploadMessage(labelsRef.current[reason]),
    );
    uploads.current = manager;
    return () => {
      uploads.current = null;
      manager.destroy();
    };
  }, [editor, hasUpload, value.profile]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editable, false);
    editor.setOptions({
      editorProps: {
        ...editor.options.editorProps,
        attributes: editorAttributes({
          label,
          ...(lang === undefined ? {} : { lang }),
          ...(dir === undefined ? {} : { dir }),
          disabled,
          readOnly,
        }),
        transformPastedHTML: sanitizePastedHTML,
      },
    });

    if (lastProp.current !== value) {
      lastProp.current = value;
      if (emitted.current === value) {
        emitted.current = null;
      } else {
        const next = normalizeEditorValue(value);
        assertSnapshotSize(next);
        editor.commands.setContent(next.doc as JSONContent, { emitUpdate: false });
      }
      lastPublishedDoc.current = editor.state.doc;
    } else if (lastPublishedDoc.current === null) {
      lastPublishedDoc.current = editor.state.doc;
    }
  }, [editor, editable, label, lang, dir, disabled, readOnly, value]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const openLink = useCallback(() => {
    if (!editor?.isEditable || !editor.schema.marks.link) return;
    const { from, to } = editor.state.selection;
    setLinkRange({ from, to });
  }, [editor]);
  const closeLink = useCallback(() => setLinkRange(null), []);

  useEffect(() => {
    if (!editor) return;
    const close = () => setLinkRange(null);
    editor.on('selectionUpdate', close);
    return () => {
      editor.off('selectionUpdate', close);
    };
  }, [editor]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      latest.current.onKeyDown?.(event);
      if (event.defaultPrevented) return;

      const modifier = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
      if (editable && editor && modifier && event.key.toLowerCase() === 'k' && editor.schema.marks.link) {
        event.preventDefault();
        openLink();
        return;
      }
      if (editable && editor && event.altKey && event.key === 'F10' && !editor.state.selection.empty) {
        event.preventDefault();
        menuContainer.current?.querySelector<HTMLButtonElement>('[role="toolbar"] button[tabindex="0"]')?.focus();
        return;
      }
      if (modifier && event.key.toLowerCase() === 's' && latest.current.onSave) {
        event.preventDefault();
        const current = editor;
        if (current) flushRef.current(current);
        latest.current.onSave();
      }
    },
    [editor, editable, openLink],
  );

  const handleCompositionEnd = useCallback(() => {
    const current = editor;
    if (!current) return;
    requestAnimationFrame(() => {
      if (!current.isDestroyed && !current.view.composing) scheduleRef.current(current);
    });
  }, [editor]);

  const coarsePointer = useCoarsePointer();
  const editorFocused = useEditorFocus(editor);
  const touchBarVisible =
    editable && toolbar !== 'never' && (toolbar === 'always' || (coarsePointer && editorFocused) || touchSheetOpen);
  const imageControl =
    editor && editable && upload && availableCommands([imageCommand], editor).length > 0 ? (
      <Button
        type="button"
        variant="outline"
        className="shrink-0 max-md:px-2.5"
        onClick={() => imageCommand.run(editor, openLink, () => setImagePosition(editor.state.selection.from))}
      >
        <ImageIcon aria-hidden="true" />
        <span className="max-md:sr-only">{resolvedLabels.image}</span>
      </Button>
    ) : null;

  return (
    <div ref={menuContainer} className={cn('relative min-w-0', className)}>
      <EditorSurface
        editor={editor}
        label={label}
        {...(lang === undefined ? {} : { lang })}
        {...(dir === undefined ? {} : { dir })}
        compact={compact}
        disabled={disabled}
        onKeyDown={handleKeyDown}
        onCompositionEnd={handleCompositionEnd}
      />
      {imageControl || actions ? (
        <div className="mt-3 flex w-full min-w-0 flex-nowrap items-center gap-2">
          {imageControl}
          {actions ? <div className="ms-auto flex shrink-0">{actions}</div> : null}
        </div>
      ) : null}
      {editor && editable ? (
        <>
          {upload && editor.schema.nodes.image && imagePosition !== null ? (
            <ImageInsert
              editor={editor}
              position={imagePosition}
              labels={resolvedLabels}
              onInsert={(files, position, alt) => uploads.current?.add(files, position, alt)}
              onClose={() => setImagePosition(null)}
            />
          ) : null}
          {lookupMention ? (
            <MentionMenu
              editor={editor}
              source={lookupMention}
              handlers={mentionHandlers}
              handles={mentionHandles}
              labels={resolvedLabels}
            />
          ) : null}
          <SlashMenu
            editor={editor}
            labels={resolvedLabels}
            upload={hasUpload}
            handlers={slashHandlers}
            onLink={openLink}
            onImage={() => setImagePosition(editor.state.selection.from)}
          />
          {toolbar !== 'never' ? (
            <EditorTouchBar
              editor={editor}
              labels={resolvedLabels}
              onLink={openLink}
              onImage={() => setImagePosition(editor.state.selection.from)}
              upload={hasUpload}
              visible={touchBarVisible}
              onSheetOpenChange={setTouchSheetOpen}
            />
          ) : null}
          <SelectionMenu
            editor={editor}
            labels={resolvedLabels}
            linkRange={linkRange}
            onLink={openLink}
            onLinkClose={closeLink}
            container={menuContainer}
            visible={!touchBarVisible}
          />
          <LinkMenu
            editor={editor}
            labels={resolvedLabels}
            range={linkRange}
            onEdit={openLink}
            onClose={closeLink}
            container={menuContainer}
          />
        </>
      ) : null}
      <div role="status" aria-label={resolvedLabels.uploading} aria-live="polite">
        {uploadEntries
          .filter((entry) => entry.phase !== 'failed')
          .map((entry) => (
            <p key={entry.id}>
              {resolvedLabels.uploading}: {entry.file.name}
            </p>
          ))}
      </div>
      {uploadEntries
        .filter((entry) => entry.phase === 'failed')
        .map((entry) => (
          <div key={entry.id} role="alert" aria-label={resolvedLabels.uploadFailed}>
            <p>
              {resolvedLabels.uploadFailed}: {entry.file.name}
            </p>
            <Button
              type="button"
              variant="secondary"
              disabled={!editable}
              onClick={() => uploads.current?.retry(entry.id)}
            >
              {resolvedLabels.retryUpload}
            </Button>
            <Button type="button" variant="ghost" onClick={() => uploads.current?.dismiss(entry.id)}>
              {resolvedLabels.dismissUpload}
            </Button>
          </div>
        ))}
      {uploadMessage ? (
        <p role="status" aria-label={resolvedLabels.image}>
          {uploadMessage}
        </p>
      ) : null}
      {snapshotError ? (
        <p role="alert" className="mt-2 text-sm text-foreground">
          {resolvedLabels.documentError}
        </p>
      ) : null}
    </div>
  );
}

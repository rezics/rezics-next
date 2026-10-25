'use client';

import {
  documentVersion,
  normalizeDocument,
  withDocumentIds,
  type DocumentNode,
  type DocumentSnapshot,
} from '@rezics/document';
import type { Editor as TiptapEditor, JSONContent } from '@tiptap/core';
import { useEditor } from '@tiptap/react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '../utils.ts';
import { EditorSurface, editorAttributes, editorExtensions, sanitizePastedHTML } from './editor-surface.ts';
import { assertSnapshotSize, editorSnapshot } from './rich-text-editor-snapshot.ts';

import { richTextEditorLabels, type RichTextEditorLabels } from './editor-labels.ts';
import { SelectionMenu } from './editor-selection-menu.tsx';
import { LinkMenu, type LinkRange } from './editor-link.tsx';

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
  maxLength?: number;
  onBlur?: () => void;
  onFocus?: () => void;
  onSave?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
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
  maxLength,
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
  const latest = useRef({ onChange, onBlur, onFocus, onSave, onKeyDown });
  latest.current = { onChange, onBlur, onFocus, onSave, onKeyDown };

  const emitted = useRef<DocumentSnapshot | null>(null);
  const lastProp = useRef(value);
  const lastPublishedDoc = useRef<TiptapEditor['state']['doc'] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const publishRef = useRef<(editor: TiptapEditor) => void>(() => undefined);
  const [snapshotError, setSnapshotError] = useState(false);
  const editable = !disabled && !readOnly;
  const menuContainer = useRef<HTMLDivElement>(null);
  const [linkRange, setLinkRange] = useState<LinkRange | null>(null);
  const resolvedLabels = useMemo(() => ({ ...richTextEditorLabels, ...labels }), [labels]);

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
      extensions: editorExtensions(value.profile, {
        ...(placeholder === undefined ? {} : { placeholder }),
        ...(maxLength === undefined ? {} : { maxLength }),
      }),
      content: normalizedValue.doc as JSONContent,
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
      {editor && editable ? (
        <>
          <SelectionMenu
            editor={editor}
            labels={resolvedLabels}
            linkRange={linkRange}
            onLink={openLink}
            onLinkClose={closeLink}
            container={menuContainer}
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
      {snapshotError ? (
        <p role="alert" className="mt-2 text-sm text-foreground">
          {resolvedLabels.documentError}
        </p>
      ) : null}
    </div>
  );
}

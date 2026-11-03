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
import { NodeSelection, Plugin, type Transaction } from '@tiptap/pm/state';
import { useEditor } from '@tiptap/react';
import { ImageIcon } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { cn } from '../utils.ts';
import { EditorSurface, editorAttributes, editorExtensions, sanitizePastedHTML } from './editor-surface.ts';
import { assertSnapshotSize, editorSnapshot } from './rich-text-editor-snapshot.ts';

import { richTextEditorLabels, type RichTextEditorLabels } from './editor-labels.ts';
import { SelectionMenu } from './editor-selection-menu.tsx';
import { EditorTouchBar } from './editor-touch-bar.tsx';
import {
  isLinkRangeValid,
  LinkMenu,
  linkHref,
  revalidateTextSelection,
  type LinkRange,
  type LinkVisitRange,
} from './editor-link.tsx';
import { ImageInsert, withImageView } from './editor-image.tsx';
import { editorUploads, type ImageUploader, type UploadEntry, type UploadState } from './editor-uploads.ts';
import { availableCommands, imageCommand, runEditorCommand } from './editor-commands.ts';
import { idleSlashHandlers, SlashMenu, slashExtension } from './editor-slash-menu.tsx';

import {
  idleMentionHandlers,
  mentionExtension,
  MentionMenu,
  withMentionView,
  type MentionSource,
  type MentionRetirement,
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
  /** Synchronous invalidation before the debounced, validated onChange snapshot. */
  onSnapshotPending?: () => void;
  /** Unnormalized editor nodes for explicit local recovery; never a submit-ready snapshot. */
  onSnapshotError?: (document: DocumentNode) => void;
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

type PendingMovedUnit = { id: string; type: string };
type PendingMovedUnitRef = { current: PendingMovedUnit | null };

const RetainMovedUnitIdentity = Extension.create<{ pendingMove: PendingMovedUnitRef }>({
  name: 'retainMovedUnitIdentity',
  addOptions: () => ({ pendingMove: { current: null } }),
  addProseMirrorPlugins() {
    const pendingMove = this.options.pendingMove;

    return [
      new Plugin({
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((transaction) => transaction.getMeta('uiEvent') === 'drop')) return;

          const movedUnit = pendingMove.current;
          pendingMove.current = null;
          if (!movedUnit || !(newState.selection instanceof NodeSelection)) return;

          const { from, node } = newState.selection;
          if (node.type.name !== movedUnit.type || typeof node.attrs.id !== 'string') return;

          // Tiptap UniqueID treats ProseMirror's copyMove drag allowance as a
          // paste and replaces the id after a same-editor block move.
          let idStillInDocument = false;
          newState.doc.descendants((candidate) => {
            if (candidate.attrs.id === movedUnit.id) idStillInDocument = true;
          });
          if (idStillInDocument) return;

          return newState.tr
            .setNodeMarkup(from, undefined, { ...node.attrs, id: movedUnit.id })
            .setMeta('addToHistory', false);
        },
      }),
    ];
  },
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

function snapshotKey(snapshot: DocumentSnapshot): string {
  return JSON.stringify(snapshot);
}

/** Keep a saved inline target attached to the same content through same-document transactions. */
function mapSavedLinkRange(
  editor: TiptapEditor,
  range: LinkVisitRange,
  transaction: Transaction,
): LinkVisitRange | null {
  if (!transaction.docChanged) return range;
  if (range.from === range.to) {
    const before = transaction.mapping.map(range.from, -1);
    const after = transaction.mapping.map(range.to, 1);
    if (before !== after) return null;
    const mapped = { ...range, from: before, to: after };
    return isLinkRangeValid(editor, mapped) ? mapped : null;
  }
  const from = transaction.mapping.map(range.from, 1);
  const to = transaction.mapping.map(range.to, -1);
  if (from >= to) return null;
  const mapped = { ...range, from, to };
  return isLinkRangeValid(editor, mapped) ? mapped : null;
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
  onSnapshotPending,
  onSnapshotError,
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
  const controlledKey = snapshotKey(normalizedValue);
  const editable = !disabled && !readOnly;
  const latest = useRef({ onChange, onBlur, onFocus, onSave, onKeyDown, onUploadState, upload, onSnapshotPending, onSnapshotError });
  latest.current = { onChange, onBlur, onFocus, onSave, onKeyDown, onUploadState, upload, onSnapshotPending, onSnapshotError };

  const controlled = useRef({ key: controlledKey, profile: value.profile });
  const emittedKey = useRef<string | null>(null);
  const lastPublishedDoc = useRef<TiptapEditor['state']['doc'] | null>(null);
  const publishedEditor = useRef<TiptapEditor | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const publishRef = useRef<(editor: TiptapEditor, epoch: number) => void>(() => undefined);
  const documentEpoch = useRef(0);
  const [documentRevision, setDocumentRevision] = useState(0);
  const [visit, setVisit] = useState(0);
  const visitRef = useRef(0);
  const mounted = useRef(false);
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const lastEditable = useRef(editable);
  const lastUploadEnabled = useRef(!!upload);
  const lastMentionEnabled = useRef(!!lookupMention);
  const currentEditor = useRef<TiptapEditor | null>(null);
  const renderedEditor = useRef<TiptapEditor | null>(null);
  const syncedEditor = useRef<TiptapEditor | null>(null);
  const renderedProfile = useRef(value.profile);
  renderedProfile.current = value.profile;
  const mentionSourceState = useRef({ enabled: !!lookupMention, generation: 0 });
  if (mentionSourceState.current.enabled !== !!lookupMention) {
    mentionSourceState.current = {
      enabled: !!lookupMention,
      generation: mentionSourceState.current.generation + 1,
    };
  }
  const committedMentionGeneration = useRef(mentionSourceState.current.generation);
  const mentionRetirement = useRef<MentionRetirement | null>(null);
  const [snapshotError, setSnapshotError] = useState(false);
  const hasUpload = !!upload;
  const hasMention = !!lookupMention;
  const menuContainer = useRef<HTMLDivElement>(null);
  const [linkRange, setLinkRange] = useState<LinkVisitRange | null>(null);
  const linkRangeRef = useRef<LinkVisitRange | null>(null);
  const nextLinkId = useRef(0);
  const [imagePosition, setImagePosition] = useState<number | null>(null);
  const imagePositionRef = useRef<number | null>(null);
  const [uploadEntries, setUploadEntries] = useState<UploadEntry[]>([]);
  const uploadEntriesRef = useRef<UploadEntry[]>([]);
  const uploadStatus = useRef<{ state: UploadState; count: number }>({ state: 'ready', count: 0 });
  const [uploadMessage, setUploadMessage] = useState('');
  const [touchSheetOpen, setTouchSheetOpen] = useState(false);
  const uploads = useRef<ReturnType<typeof editorUploads> | null>(null);
  const uploadLease = useRef<symbol | null>(null);
  const resolvedLabels = useMemo(() => ({ ...richTextEditorLabels, ...labels }), [labels]);

  const labelsRef = useRef(resolvedLabels);
  labelsRef.current = resolvedLabels;
  const slashHandlers = useRef(idleSlashHandlers);
  const mentionHandlers = useRef(idleMentionHandlers);
  const mentionEnabled = useRef(hasMention);
  mentionEnabled.current = hasMention;
  const mentionHandles = useRef(new Map<string, string>());
  const mentionHandleUsage = useRef(new Map<string, number>());
  const pendingMovedUnit = useRef<PendingMovedUnit | null>(null);

  const publish = useCallback(
    (editor: TiptapEditor, epoch: number) => {
      if (
        !mounted.current ||
        epoch !== documentEpoch.current ||
        editor !== currentEditor.current ||
        editor.isDestroyed ||
        editor.view.composing ||
        lastPublishedDoc.current === editor.state.doc
      )
        return;

      let snapshot: DocumentSnapshot;
      try {
        snapshot = editorSnapshot(editor.state.doc, value.profile);
      } catch {
        setSnapshotError(true);
        latest.current.onSnapshotError?.(editor.state.doc.toJSON() as DocumentNode);
        return;
      }

      setSnapshotError(false);
      emittedKey.current = snapshotKey(snapshot);
      lastPublishedDoc.current = editor.state.doc;
      publishedEditor.current = editor;
      latest.current.onChange(snapshot);
      uploads.current?.snapshot(editor.state.doc);
    },
    [value.profile],
  );
  publishRef.current = publish;

  const schedulePublish = useCallback((editor: TiptapEditor) => {
    if (editor.isDestroyed || !mounted.current) return;
    latest.current.onSnapshotPending?.();
    if (editor.view.composing) return;
    if (timer.current !== null) clearTimeout(timer.current);
    const epoch = documentEpoch.current;
    timer.current = setTimeout(() => {
      timer.current = null;
      publishRef.current(editor, epoch);
    }, 150);
  }, []);

  const flushPublish = useCallback((editor: TiptapEditor, epoch = documentEpoch.current) => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    publishRef.current(editor, epoch);
  }, []);

  const scheduleRef = useRef(schedulePublish);
  scheduleRef.current = schedulePublish;
  const flushRef = useRef<(editor: TiptapEditor, epoch?: number) => void>(() => undefined);
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
          mentionHandleUsage,
        ),
        RetainMovedUnitIdentity.configure({ pendingMove: pendingMovedUnit }),
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
        handleDOMEvents: {
          dragstart: (view, event) => {
            const drag = event as DragEvent;
            if (!view.editable || !drag.dataTransfer) return false;

            // Select an identified block before ProseMirror reads the drag
            // selection, so its native gesture moves the document unit itself.
            let candidate = drag.target instanceof Element ? drag.target.closest<HTMLElement>('[data-id]') : null;
            while (candidate && candidate !== view.dom) {
              const id = candidate.getAttribute('data-id');
              let selectedBlock = false;
              if (id) {
                try {
                  const position = view.posAtDOM(candidate, 0);
                  const $position = view.state.doc.resolve(position);
                  for (let depth = $position.depth; depth > 0; depth--) {
                    const node = $position.node(depth);
                    if (node.attrs.id !== id || !node.type.spec.draggable) continue;

                    const selection = NodeSelection.create(view.state.doc, $position.before(depth));
                    if (!selection.eq(view.state.selection)) {
                      view.dispatch(view.state.tr.setSelection(selection));
                    }
                    selectedBlock = true;
                    break;
                  }
                } catch {
                  // Nested node views may not map their wrapper DOM to a single
                  // document position; the nearest identified ancestor is tried.
                }
              }
              if (selectedBlock) break;
              candidate = candidate.parentElement?.closest<HTMLElement>('[data-id]') ?? null;
            }

            // UniqueID treats copyMove as a copied slice and regenerates unit
            // IDs. Same-editor drags are moves; Ctrl-drag remains a copy.
            drag.dataTransfer.effectAllowed = drag.ctrlKey ? 'copy' : 'move';
            return false;
          },
          drop: (view) => {
            const dragging = view.dragging;
            const draggedNode = view.state.selection instanceof NodeSelection ? view.state.selection.node : null;
            if (dragging?.move && draggedNode) {
              const { attrs, type } = draggedNode;
              if (typeof attrs.id === 'string') pendingMovedUnit.current = { id: attrs.id, type: type.name };
            }
            return false;
          },
          dragend: () => {
            pendingMovedUnit.current = null;
            return false;
          },
        },
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
        if (!mounted.current || renderedEditor.current !== current || current.isDestroyed) return;
        flushRef.current(current);
        latest.current.onBlur?.();
      },
      onFocus: ({ editor: current }) => {
        if (mounted.current && renderedEditor.current === current && !current.isDestroyed) latest.current.onFocus?.();
      },
    },
    [value.profile, placeholder, maxLength],
  );
  renderedEditor.current = editor;

  const schemaMatchesProfile = editor !== null && Boolean(editor.schema.nodes.image) === (value.profile === 'blocks');
  const previousControlled = controlled.current;
  const renderedProfileChanged = previousControlled.profile !== value.profile;
  const renderedIncomingChanged = previousControlled.key !== controlledKey || renderedProfileChanged;
  const renderedEcho = !renderedProfileChanged && emittedKey.current === controlledKey;
  let renderedSameAsEditor = false;
  if (renderedIncomingChanged && !renderedProfileChanged && schemaMatchesProfile && editor) {
    try {
      renderedSameAsEditor = snapshotKey(editorSnapshot(editor.state.doc, value.profile)) === controlledKey;
    } catch {
      renderedSameAsEditor = false;
    }
  }
  const renderedExternalReplacement =
    renderedIncomingChanged && (renderedProfileChanged || (!renderedEcho && !renderedSameAsEditor));
  const renderedEditorReplacement = syncedEditor.current !== null && syncedEditor.current !== editor;
  const currentMentionGeneration = mentionSourceState.current.generation;

  const ownsVisit = useCallback(
    (
      owner: number,
      ownerProfile: DocumentSnapshot['profile'],
      ownerMentionGeneration: number,
      target: TiptapEditor | null,
    ) =>
      mounted.current &&
      !renderedExternalReplacement &&
      !renderedEditorReplacement &&
      owner === visitRef.current &&
      ownerProfile === renderedProfile.current &&
      ownerMentionGeneration === mentionSourceState.current.generation &&
      ownerMentionGeneration === committedMentionGeneration.current &&
      target !== null &&
      target === renderedEditor.current &&
      editableRef.current &&
      schemaMatchesProfile &&
      !target.isDestroyed &&
      target.isEditable,
    [renderedEditorReplacement, renderedExternalReplacement, schemaMatchesProfile],
  );
  const isCurrent = useCallback(
    () => ownsVisit(visit, value.profile, currentMentionGeneration, editor),
    [currentMentionGeneration, editor, ownsVisit, value.profile, visit],
  );
  const isCurrentLinkRange = useCallback(
    (range: LinkVisitRange) => {
      const current = linkRangeRef.current;
      return Boolean(
        isCurrent() &&
        current &&
        current.id === range.id &&
        current.visit === range.visit &&
        current.from === range.from &&
        current.to === range.to &&
        current.url === range.url,
      );
    },
    [isCurrent],
  );
  const registerMentionRetirement = useCallback((retirement: MentionRetirement) => {
    mentionRetirement.current = retirement;
    return () => {
      if (mentionRetirement.current === retirement) mentionRetirement.current = null;
    };
  }, []);
  const setOwnedLinkRange = useCallback((range: LinkVisitRange | null) => {
    linkRangeRef.current = range;
    setLinkRange(range);
  }, []);
  const updateLinkUrl = useCallback(
    (range: LinkVisitRange, url: string) => {
      if (!isCurrentLinkRange(range)) return;
      setOwnedLinkRange({ ...range, url });
    },
    [isCurrentLinkRange, setOwnedLinkRange],
  );
  const setOwnedImagePosition = useCallback((position: number | null) => {
    imagePositionRef.current = position;
    setImagePosition(position);
  }, []);
  const retireInlineWork = useCallback(() => {
    const previousVisit = visitRef.current;
    visitRef.current = previousVisit + 1;
    const retirement = mentionRetirement.current;
    mentionRetirement.current = null;
    if (retirement?.visit === previousVisit) retirement.retire();
    mentionHandles.current.clear();
    mentionHandlers.current = idleMentionHandlers;
    slashHandlers.current = idleSlashHandlers;
    setOwnedLinkRange(null);
    setOwnedImagePosition(null);
    setTouchSheetOpen(false);
    setVisit(visitRef.current);
  }, [setOwnedImagePosition, setOwnedLinkRange]);

  const resetUploadState = useCallback((notify: boolean) => {
    const hadState =
      uploadEntriesRef.current.length > 0 || uploadStatus.current.state !== 'ready' || uploadStatus.current.count !== 0;
    uploadEntriesRef.current = [];
    setUploadEntries((entries) => (entries.length ? [] : entries));
    setUploadMessage('');
    if (!hadState) return;
    uploadStatus.current = { state: 'ready', count: 0 };
    if (notify) latest.current.onUploadState?.('ready', 0);
  }, []);

  const retireUploads = useCallback(
    (notify: boolean, restart = false) => {
      const manager = uploads.current;
      uploads.current = null;
      uploadLease.current = null;
      manager?.destroy();
      resetUploadState(notify);
      if (restart) setDocumentRevision((revision) => revision + 1);
    },
    [resetUploadState],
  );

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      mentionRetirement.current?.retire();
      mentionRetirement.current = null;
      mentionHandlers.current = idleMentionHandlers;
      slashHandlers.current = idleSlashHandlers;
      mentionHandles.current.clear();
      mentionHandleUsage.current.clear();
      linkRangeRef.current = null;
      imagePositionRef.current = null;
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, []);

  useLayoutEffect(() => {
    currentEditor.current = editor;
    return () => {
      if (currentEditor.current === editor) currentEditor.current = null;
    };
  }, [editor]);

  useLayoutEffect(() => {
    const previous = controlled.current;
    const profileChanged = previous.profile !== value.profile;
    const incomingChanged = previous.key !== controlledKey || profileChanged;
    const editorChanged = syncedEditor.current !== null && syncedEditor.current !== editor;
    syncedEditor.current = editor;
    const wasEditable = lastEditable.current;
    const wasUploadEnabled = lastUploadEnabled.current;
    const wasMentionEnabled = lastMentionEnabled.current;
    lastEditable.current = editable;
    lastUploadEnabled.current = hasUpload;
    lastMentionEnabled.current = hasMention;

    if (editor) {
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
    }

    let externalReplacement = false;
    let echo = false;
    if (incomingChanged) {
      controlled.current = { key: controlledKey, profile: value.profile };
      echo = !profileChanged && emittedKey.current === controlledKey;
      let sameAsEditor = false;
      if (!profileChanged && schemaMatchesProfile && editor) {
        try {
          sameAsEditor = snapshotKey(editorSnapshot(editor.state.doc, value.profile)) === controlledKey;
        } catch {
          sameAsEditor = false;
        }
      }
      externalReplacement = profileChanged || (!echo && !sameAsEditor);
    }

    const lostEditability = wasEditable && !editable;
    const gainedEditability = !wasEditable && editable;
    const lostUploader = wasUploadEnabled && !hasUpload;
    const mentionAvailabilityChanged = wasMentionEnabled !== hasMention;
    if (
      externalReplacement ||
      editorChanged ||
      lostEditability ||
      gainedEditability ||
      lostUploader ||
      mentionAvailabilityChanged
    )
      retireInlineWork();
    committedMentionGeneration.current = mentionSourceState.current.generation;
    if (externalReplacement || editorChanged || lostEditability || lostUploader) {
      if (externalReplacement) {
        emittedKey.current = null;
        documentEpoch.current += 1;
      } else if (incomingChanged && echo) {
        emittedKey.current = null;
      }
      if (externalReplacement || editorChanged) {
        if (timer.current !== null) {
          clearTimeout(timer.current);
          timer.current = null;
        }
      }
      retireUploads(true, externalReplacement && !editorChanged);
      if (lostUploader && !externalReplacement && !editorChanged && !lostEditability) setOwnedImagePosition(null);
      if (externalReplacement) {
        setSnapshotError(false);
        if (schemaMatchesProfile && editor) {
          editor.commands.setContent(normalizedValue.doc as JSONContent, { emitUpdate: false });
          lastPublishedDoc.current = editor.state.doc;
          publishedEditor.current = editor;
        } else {
          lastPublishedDoc.current = null;
          publishedEditor.current = null;
        }
      }
    } else if (incomingChanged && echo) {
      emittedKey.current = null;
      if (editor && !editor.isDestroyed) {
        revalidateTextSelection(editor);
        const range = linkRangeRef.current;
        if (range?.visit === visitRef.current && !isLinkRangeValid(editor, range)) setOwnedLinkRange(null);
      }
    } else if (incomingChanged) {
      emittedKey.current = null;
    }

    if (editor && schemaMatchesProfile && publishedEditor.current !== editor) {
      lastPublishedDoc.current = editor.state.doc;
      publishedEditor.current = editor;
    } else if (editor && schemaMatchesProfile && lastPublishedDoc.current === null) {
      lastPublishedDoc.current = editor.state.doc;
      publishedEditor.current = editor;
    }
  }, [
    editor,
    editable,
    hasUpload,
    hasMention,
    label,
    lang,
    dir,
    disabled,
    readOnly,
    controlledKey,
    value.profile,
    retireInlineWork,
    retireUploads,
    setOwnedImagePosition,
  ]);

  useLayoutEffect(() => {
    if (!editor) return;
    const mapRange = ({ transaction }: { transaction: Transaction }) => {
      const range = linkRangeRef.current;
      if (renderedEditor.current !== editor || !editableRef.current || editor.isDestroyed) return;
      if (range && range.visit === visitRef.current) {
        const mapped = mapSavedLinkRange(editor, range, transaction);
        if (mapped) setOwnedLinkRange(mapped);
        else setOwnedLinkRange(null);
      }
      const imagePosition = imagePositionRef.current;
      if (transaction.docChanged && imagePosition !== null) {
        const before = transaction.mapping.map(imagePosition, -1);
        const after = transaction.mapping.map(imagePosition, 1);
        setOwnedImagePosition(before === after ? before : null);
      }
    };
    editor.on('transaction', mapRange);
    return () => {
      editor.off('transaction', mapRange);
    };
  }, [editor, setOwnedImagePosition, setOwnedLinkRange]);

  useLayoutEffect(() => {
    if (!editor || !editable || !hasUpload || Boolean(editor.schema.nodes.image) !== (value.profile === 'blocks'))
      return;

    const lease = Symbol('editor upload document');
    const ownerEpoch = documentEpoch.current;
    uploadLease.current = lease;
    const current = () =>
      mounted.current &&
      uploadLease.current === lease &&
      documentEpoch.current === ownerEpoch &&
      currentEditor.current === editor &&
      editableRef.current &&
      !editor.isDestroyed &&
      editor.isEditable;
    const manager = editorUploads(
      editor,
      value.profile,
      () => latest.current.upload,
      (state, count, entries) => {
        if (!current()) return;
        uploadEntriesRef.current = entries;
        setUploadEntries(entries);
        if (state === 'pending') setUploadMessage('');
        if (uploadStatus.current.state !== state || uploadStatus.current.count !== count) {
          uploadStatus.current = { state, count };
          latest.current.onUploadState?.(state, count);
        }
      },
      () => {
        if (current()) flushRef.current(editor, ownerEpoch);
      },
      (reason) => {
        if (current()) setUploadMessage(labelsRef.current[reason]);
      },
      current,
    );
    uploads.current = manager;
    return () => {
      if (uploadLease.current !== lease) return;
      uploads.current = null;
      uploadLease.current = null;
      manager.destroy();
      resetUploadState(true);
    };
  }, [editor, editable, hasUpload, value.profile, documentRevision, resetUploadState]);

  const focusEditor = useCallback(() => {
    if (isCurrent() && editor && !editor.isDestroyed && editor.isEditable) editor.view.focus();
  }, [editor, isCurrent]);
  const openLink = useCallback(() => {
    if (!isCurrent() || !editor?.schema.marks.link) return;
    const selection = editor.state.selection;
    if (!selection.$from.parent.inlineContent || !selection.$to.parent.inlineContent) return;
    setOwnedLinkRange({
      from: selection.from,
      to: selection.to,
      id: ++nextLinkId.current,
      visit,
      url: linkHref(editor, selection),
    });
  }, [editor, isCurrent, setOwnedLinkRange, visit]);
  const openLinkForRange = useCallback(
    (range: LinkRange) => {
      if (
        !isCurrent() ||
        !editor ||
        editor.state.selection.from !== range.from ||
        editor.state.selection.to !== range.to
      )
        return;
      openLink();
    },
    [editor, isCurrent, openLink],
  );
  const closeLink = useCallback(
    (id: number) => {
      if (!isCurrent()) return;
      const current = linkRangeRef.current;
      if (current?.id !== id) return;
      setOwnedLinkRange(null);
    },
    [isCurrent, setOwnedLinkRange],
  );
  const isCurrentImagePosition = useCallback(
    (position: number) => isCurrent() && imagePositionRef.current === position,
    [isCurrent],
  );
  const openImage = useCallback(() => {
    if (isCurrent() && editor && !editor.isDestroyed && editor.isEditable)
      setOwnedImagePosition(editor.state.selection.from);
  }, [editor, isCurrent, setOwnedImagePosition]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (!isCurrent()) return;
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
    [editor, editable, isCurrent, openLink],
  );

  const handleCompositionEnd = useCallback(() => {
    const current = editor;
    if (!current || !isCurrent()) return;
    requestAnimationFrame(() => {
      if (isCurrent() && !current.isDestroyed && !current.view.composing) scheduleRef.current(current);
    });
  }, [editor, isCurrent]);

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
        onClick={() => runEditorCommand(imageCommand, editor, openLink, openImage, isCurrent)}
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
          {isCurrent() && upload && editor.schema.nodes.image && imagePosition !== null ? (
            <ImageInsert
              key={visit}
              editor={editor}
              position={imagePosition}
              labels={resolvedLabels}
              onInsert={(files, position, alt) => {
                if (isCurrentImagePosition(position)) uploads.current?.add(files, position, alt);
              }}
              onClose={() => {
                if (imagePosition !== null && isCurrentImagePosition(imagePosition)) setOwnedImagePosition(null);
              }}
            />
          ) : null}
          {lookupMention && isCurrent() ? (
            <MentionMenu
              key={visit}
              editor={editor}
              source={lookupMention}
              handlers={mentionHandlers}
              handles={mentionHandles}
              labels={resolvedLabels}
              visit={visit}
              isCurrent={isCurrent}
              registerRetirement={registerMentionRetirement}
            />
          ) : null}
          <SlashMenu
            key={`slash-${visit}`}
            editor={editor}
            labels={resolvedLabels}
            upload={hasUpload}
            handlers={slashHandlers}
            onLink={openLink}
            onImage={openImage}
            visit={visit}
            isCurrent={isCurrent}
          />
          {toolbar !== 'never' ? (
            <EditorTouchBar
              key={`touch-${visit}`}
              editor={editor}
              labels={resolvedLabels}
              onLink={openLink}
              onImage={openImage}
              upload={hasUpload}
              visible={touchBarVisible}
              onSheetOpenChange={(open) => {
                if (isCurrent()) setTouchSheetOpen(open);
              }}
              isCurrent={isCurrent}
            />
          ) : null}
          <SelectionMenu
            key={`selection-${visit}`}
            editor={editor}
            labels={resolvedLabels}
            linkRange={linkRange}
            onLink={openLink}
            onLinkClose={() => {
              if (linkRange) closeLink(linkRange.id);
            }}
            container={menuContainer}
            visible={!touchBarVisible}
            isCurrent={isCurrent}
            isRangeCurrent={isCurrentLinkRange}
            onLinkUrlChange={updateLinkUrl}
            focusEditor={focusEditor}
          />
          <LinkMenu
            key={`link-${visit}`}
            editor={editor}
            labels={resolvedLabels}
            range={linkRange}
            onEdit={openLinkForRange}
            onClose={() => {
              if (linkRange) closeLink(linkRange.id);
            }}
            container={menuContainer}
            isCurrent={isCurrent}
            isRangeCurrent={isCurrentLinkRange}
            onUrlChange={updateLinkUrl}
            focusEditor={focusEditor}
            rangeVisible={touchBarVisible}
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

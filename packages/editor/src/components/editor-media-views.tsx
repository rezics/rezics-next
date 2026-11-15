'use client';

import { Button } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { ResponsiveDialog } from '@rezics/ui/responsive-dialog';
import { Extension, type Editor, type Extensions, type Node as TiptapNode } from '@tiptap/core';
import { Plugin, NodeSelection } from '@tiptap/pm/state';
import { NodeViewWrapper, ReactNodeViewRenderer, useEditorState, type NodeViewProps } from '@tiptap/react';
import { useCallback, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  DocumentImageView,
  DocumentMediaView,
  documentImageOccurrence,
  documentMediaOccurrence,
  imageOccurrenceKey,
} from './document-media.tsx';
import { editorMediaLabels, type EditorMediaLabels } from './editor-media-labels.ts';
import {
  applyImageProperties,
  applyMediaCaption,
  currentMediaPosition,
  imageDimension,
  type MediaEditTarget,
} from './editor-media-commands.ts';
import {
  clearEditorImagePreviews,
  discardEditorImagePreview,
  editorMediaRuntime,
  pruneEditorImagePreviewsFromDocument,
  type EditorMediaPorts,
} from './editor-media-runtime.ts';
import type { RichTextEditorLabels } from './editor-labels.ts';
import type { EditorBehaviorAction } from './editor-behavior-actions.ts';

export type EditorMediaPropertiesDraft = {
  alt: string;
  title: string;
  width: string;
  height: string;
  conceal: boolean;
  caption: string;
};

function controlLabel(labels: RichTextEditorLabels, key: keyof EditorMediaLabels) {
  return (labels as Partial<EditorMediaLabels>)[key] ?? editorMediaLabels[key];
}

/** Occurrence property form. Apply still goes through the captured target in MediaView. */
export function EditorMediaPropertiesDialog({
  image,
  labels,
  draft,
  onDraftChange,
  composing,
  touched,
  onSubmit,
  onCancel,
}: {
  image: boolean;
  labels: RichTextEditorLabels;
  draft: EditorMediaPropertiesDraft;
  onDraftChange: (draft: EditorMediaPropertiesDraft) => void;
  composing: { current: boolean };
  touched: { current: { alt: boolean; title: boolean } };
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const field = useId();
  const invalidWidth = imageDimension(draft.width) === false;
  const invalidHeight = imageDimension(draft.height) === false;
  const validDimensions = !invalidWidth && !invalidHeight;
  const dimensionsHelp = `${field}-dimensions-help`;
  const dimensionsError = `${field}-dimensions-error`;
  const dimensionsDescribedBy = validDimensions ? dimensionsHelp : `${dimensionsHelp} ${dimensionsError}`;
  return (
    <ResponsiveDialog
      open
      title={controlLabel(labels, image ? 'imageProperties' : 'mediaProperties')}
      description={controlLabel(labels, image ? 'imagePropertiesHelp' : 'mediaPropertiesHelp')}
      closeLabel={labels.cancel}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      finalFocus={() => false}
    >
      <form
        className="flex min-w-0 flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!composing.current) onSubmit();
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          if (
            event.nativeEvent.isComposing ||
            event.keyCode === 229 ||
            composing.current ||
            ['Process', 'Dead'].includes(event.key) ||
            event.getModifierState('AltGraph')
          )
            return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
          if (event.key === 'Enter') {
            event.stopPropagation();
            if ((event.target as HTMLElement).tagName === 'INPUT') {
              event.preventDefault();
              onSubmit();
            }
          }
        }}
      >
        <FieldGroup className="min-w-0 gap-3">
          {image ? (
            <>
              <Field className="min-w-0">
                <FieldLabel htmlFor={`${field}-alt`}>{labels.imageAlt}</FieldLabel>
                <Textarea
                  id={`${field}-alt`}
                  autoFocus
                  className="min-w-0"
                  value={draft.alt}
                  onChange={(event) => {
                    touched.current.alt = true;
                    onDraftChange({ ...draft, alt: event.target.value });
                  }}
                />
              </Field>
              <Field className="min-w-0">
                <FieldLabel htmlFor={`${field}-title`}>{controlLabel(labels, 'imageTitle')}</FieldLabel>
                <Input
                  id={`${field}-title`}
                  className="min-w-0"
                  value={draft.title}
                  onChange={(event) => {
                    touched.current.title = true;
                    onDraftChange({ ...draft, title: event.target.value });
                  }}
                />
              </Field>
              <Field className="min-w-0" data-invalid={invalidWidth || undefined}>
                <FieldLabel htmlFor={`${field}-width`}>{controlLabel(labels, 'imageWidth')}</FieldLabel>
                <Input
                  id={`${field}-width`}
                  type="number"
                  min="0"
                  step="any"
                  className="min-w-0"
                  value={draft.width}
                  aria-invalid={invalidWidth || undefined}
                  aria-describedby={dimensionsDescribedBy}
                  onChange={(event) => onDraftChange({ ...draft, width: event.target.value })}
                />
              </Field>
              <Field className="min-w-0" data-invalid={invalidHeight || undefined}>
                <FieldLabel htmlFor={`${field}-height`}>{controlLabel(labels, 'imageHeight')}</FieldLabel>
                <Input
                  id={`${field}-height`}
                  type="number"
                  min="0"
                  step="any"
                  className="min-w-0"
                  value={draft.height}
                  aria-invalid={invalidHeight || undefined}
                  aria-describedby={dimensionsDescribedBy}
                  onChange={(event) => onDraftChange({ ...draft, height: event.target.value })}
                />
              </Field>
              <FieldDescription id={dimensionsHelp}>{controlLabel(labels, 'imageDimensionsHelp')}</FieldDescription>
              {validDimensions ? null : (
                <FieldError id={dimensionsError}>{controlLabel(labels, 'invalidImageDimensions')}</FieldError>
              )}
              <Field orientation="horizontal" className="min-w-0">
                <Checkbox
                  id={`${field}-conceal`}
                  checked={draft.conceal}
                  onCheckedChange={(checked) => onDraftChange({ ...draft, conceal: checked === true })}
                />
                <FieldLabel htmlFor={`${field}-conceal`} className="min-w-0 text-wrap">
                  {controlLabel(labels, 'imageConceal')}
                </FieldLabel>
              </Field>
            </>
          ) : (
            <Field className="min-w-0">
              <FieldLabel htmlFor={`${field}-caption`}>{controlLabel(labels, 'mediaCaption')}</FieldLabel>
              <Textarea
                id={`${field}-caption`}
                autoFocus
                className="min-w-0"
                value={draft.caption}
                onChange={(event) => onDraftChange({ ...draft, caption: event.target.value })}
              />
            </Field>
          )}
          <Field orientation="horizontal" className="flex-wrap items-center">
            <Button
              type="submit"
              variant="secondary"
              className="h-auto min-h-7 max-w-full whitespace-normal text-start"
              disabled={image && !validDimensions}
            >
              {labels.apply}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-auto min-h-7 max-w-full whitespace-normal text-start"
              onClick={onCancel}
            >
              {labels.cancel}
            </Button>
          </Field>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  );
}

function OpaqueView({ node, editor, selected, fallback }: NodeViewProps & { fallback: () => EditorMediaPorts }) {
  const runtime = editorMediaRuntime(editor);
  const subscribe = useCallback(
    (listener: () => void) => {
      runtime.listeners.add(listener);
      return () => {
        runtime.listeners.delete(listener);
      };
    },
    [runtime],
  );
  useSyncExternalStore(
    subscribe,
    () => runtime.revision,
    () => runtime.revision,
  );
  const ports = runtime.ports?.() ?? fallback();
  const unavailable =
    (ports.labels as Partial<EditorMediaLabels>).embeddedComponent ?? editorMediaLabels.embeddedComponent;
  return (
    <NodeViewWrapper
      as={node.isInline ? 'span' : 'div'}
      contentEditable={false}
      data-block-id={node.attrs.id}
      data-id={node.attrs.id}
      data-drag-handle={!node.isInline ? '' : undefined}
      className={`${node.isInline ? 'inline' : 'my-3 block p-3'} rounded-xl border border-border text-sm ${selected ? 'ring-2 ring-ring' : ''}`}
    >
      {node.attrs.fallback || unavailable}
    </NodeViewWrapper>
  );
}

function MediaView({ node, editor, getPos, selected, fallback }: NodeViewProps & { fallback: () => EditorMediaPorts }) {
  const runtime = editorMediaRuntime(editor);
  const subscribe = useCallback(
    (listener: () => void) => {
      runtime.listeners.add(listener);
      return () => {
        runtime.listeners.delete(listener);
      };
    },
    [runtime],
  );
  useSyncExternalStore(
    subscribe,
    () => runtime.revision,
    () => runtime.revision,
  );
  const ports = runtime.ports?.() ?? fallback();
  const generation = runtime.generation;
  const label = (key: keyof EditorMediaLabels) =>
    (ports.labels as Partial<EditorMediaLabels>)[key] ?? editorMediaLabels[key];
  const image = node.type.name === 'image';
  const occurrence = documentImageOccurrence(node);
  const media = documentMediaOccurrence(node);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditorMediaPropertiesDraft>({
    alt: '',
    title: '',
    width: '',
    height: '',
    conceal: false,
    caption: '',
  });
  const [failedPreview, setFailedPreview] = useState<string>();
  const target = useRef<MediaEditTarget | null>(null);
  const returning = useRef<{ target: MediaEditTarget; owner: Element | null } | null>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const composing = useRef(false);
  const touched = useRef({ alt: false, title: false });
  const mounted = useRef(false);
  const current = () => mounted.current && runtime.generation === generation && ports.isCurrent();
  const canPresent = () => runtime.generation === generation && ports.isCurrent();
  const editingCurrent = editing && target.current !== null && currentMediaPosition(target.current, current) !== null;
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      target.current = null;
    };
  }, []);

  const open = () => {
    const captured = { node, editor, getPos, generation, currentGeneration: () => runtime.generation };
    if (!current() || currentMediaPosition(captured, current) === null) return false;
    target.current = captured;
    composing.current = false;
    touched.current = { alt: false, title: false };
    returning.current = null;
    setDraft({
      alt: occurrence.alt,
      title: occurrence.title ?? '',
      width: occurrence.width?.toString() ?? '',
      height: occurrence.height?.toString() ?? '',
      conceal: occurrence.conceal,
      caption: media.caption,
    });
    setEditing(true);
    return true;
  };
  useLayoutEffect(() => {
    runtime.properties.set(String(node.attrs.id), open);
    return () => {
      if (runtime.properties.get(String(node.attrs.id)) === open) runtime.properties.delete(String(node.attrs.id));
    };
  });
  useLayoutEffect(() => {
    if (editing && !editingCurrent) {
      target.current = null;
      returning.current = null;
      setEditing(false);
      composing.current = false;
    }
    if (!editing && returning.current) {
      const saved = returning.current;
      returning.current = null;
      if (currentMediaPosition(saved.target, current) === null) return;
      const active = document.activeElement;
      if (active === saved.owner || active === document.body || !active?.isConnected) editButton.current?.focus();
    }
  });
  function finish(apply: boolean) {
    const captured = target.current;
    target.current = null;
    if (!captured || currentMediaPosition(captured, current) === null) {
      setEditing(false);
      return;
    }
    const owner = document.activeElement;
    const width = imageDimension(draft.width);
    const height = imageDimension(draft.height);
    if (apply && image && (width === false || height === false)) {
      target.current = captured;
      return;
    }
    const pos = captured.getPos()!;
    const changed =
      !apply ||
      (image
        ? applyImageProperties(
            captured,
            {
              alt: touched.current.alt ? draft.alt : (captured.node.attrs.alt ?? null),
              title: touched.current.title ? draft.title || null : (captured.node.attrs.title ?? null),
              width: width as number | null,
              height: height as number | null,
              conceal: draft.conceal,
            },
            current,
          )
        : applyMediaCaption(captured, draft.caption, current));
    if (!changed) {
      target.current = captured;
      return;
    }
    const updated = editor.state.doc.nodeAt(pos);
    if (updated && updated.attrs.id === captured.node.attrs.id && updated.attrs.src === captured.node.attrs.src)
      returning.current = { target: { ...captured, node: updated }, owner };
    setEditing(false);
  }
  const preview = runtime.previews.get(occurrence.id);
  const local = preview?.src === occurrence.src && failedPreview !== preview.url ? preview : undefined;
  const admitted = useRef(false);
  admitted.current = false;
  const renderer = (image: typeof occurrence) => {
    if (!canPresent()) return null;
    const presentation = ports.renderImage?.(image);
    admitted.current = presentation !== null && presentation !== undefined;
    return (
      presentation ??
      (local ? (
        <img
          src={local.url}
          alt={occurrence.alt || ports.labels.image}
          title={occurrence.title ?? undefined}
          width={occurrence.width ?? undefined}
          height={occurrence.height ?? undefined}
          style={{
            ...(occurrence.width ? { width: occurrence.width } : {}),
            ...(occurrence.height ? { height: occurrence.height } : {}),
          }}
          className="block h-auto max-w-full"
          onError={() => {
            if (current() && runtime.previews.get(occurrence.id)?.url === local.url) setFailedPreview(local.url);
          }}
        />
      ) : null)
    );
  };
  useLayoutEffect(() => {
    if (current() && admitted.current && local && runtime.previews.get(occurrence.id)?.url === local.url)
      discardEditorImagePreview(editor, occurrence.id);
  });
  return (
    <NodeViewWrapper
      as="figure"
      contentEditable={false}
      data-block-id={node.attrs.id}
      data-id={node.attrs.id}
      className={`my-3 min-w-0 max-w-full space-y-2 rounded-xl border p-3 font-sans text-sm ${selected ? 'ring-2 ring-ring' : 'border-border'}`}
    >
      <div data-drag-handle>
        {image ? (
          <DocumentImageView
            key={`${runtime.generation}:${imageOccurrenceKey(occurrence)}`}
            image={occurrence}
            {...(renderer ? { renderImage: renderer } : {})}
            unavailable={label('imageUnavailable')}
            reveal={label('revealImage')}
            isCurrent={current}
          />
        ) : (
          <DocumentMediaView
            media={media}
            renderMedia={(media) => (canPresent() ? ports.renderMedia?.(media) : null)}
            unavailable={label('mediaUnavailable')}
          />
        )}
      </div>
      {editor.isEditable ? (
        editingCurrent ? (
          <EditorMediaPropertiesDialog
            image={image}
            labels={ports.labels}
            draft={draft}
            onDraftChange={setDraft}
            composing={composing}
            touched={touched}
            onSubmit={() => finish(true)}
            onCancel={() => finish(false)}
          />
        ) : (
          <Button
            ref={editButton}
            type="button"
            variant="outline"
            className="h-auto min-h-7 max-w-full whitespace-normal text-start"
            onClick={open}
          >
            {label(image ? 'imageProperties' : 'mediaProperties')}
          </Button>
        )
      ) : null}
    </NodeViewWrapper>
  );
}

export function withMediaViews(extensions: Extensions, getPorts: () => EditorMediaPorts): Extensions {
  return [
    ...extensions.map((extension) =>
      ['image', 'media', 'extensionBlock', 'extensionInline'].includes(extension.name)
        ? (extension as TiptapNode).extend({
            addNodeView() {
              editorMediaRuntime(this.editor).ports = getPorts;
              return ReactNodeViewRenderer((props) =>
                ['extensionBlock', 'extensionInline'].includes(props.node.type.name) ? (
                  <OpaqueView {...props} fallback={getPorts} />
                ) : (
                  <MediaView {...props} fallback={getPorts} />
                ),
              );
            },
          })
        : extension,
    ),
    Extension.create({
      name: 'documentMediaViews',
      addProseMirrorPlugins() {
        const editor = this.editor;
        const runtime = editorMediaRuntime(editor);
        runtime.ports = getPorts;
        return [
          new Plugin({
            view(view) {
              let editable = view.editable;
              return {
                update(next, previous) {
                  if (next.state.doc !== previous.doc) pruneEditorImagePreviewsFromDocument(editor, next.state.doc);
                  if (editable !== next.editable) {
                    editable = next.editable;
                    runtime.revision++;
                    for (const listener of runtime.listeners) listener();
                  }
                },
                destroy() {
                  runtime.generation++;
                  runtime.listeners.clear();
                  runtime.properties.clear();
                  runtime.ports = null;
                  clearEditorImagePreviews(editor);
                },
              };
            },
          }),
        ];
      },
    }),
  ];
}

/** Current atom actions enter the same properties owner as the visible node-view button. */
export function EditorMediaControls({
  editor,
  labels,
  isCurrent,
  onCommands,
}: {
  editor: Editor;
  labels: RichTextEditorLabels;
  isCurrent: () => boolean;
  onCommands?: (commands: readonly EditorBehaviorAction[]) => void;
}) {
  const runtime = editorMediaRuntime(editor);
  const subscribe = useCallback(
    (listener: () => void) => {
      runtime.listeners.add(listener);
      return () => {
        runtime.listeners.delete(listener);
      };
    },
    [runtime],
  );
  useSyncExternalStore(
    subscribe,
    () => runtime.revision,
    () => runtime.revision,
  );
  const generation = runtime.generation;
  const selected = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      current.state.selection instanceof NodeSelection
        ? { type: current.state.selection.node.type.name, id: String(current.state.selection.node.attrs.id ?? '') }
        : null,
  });
  useLayoutEffect(() => {
    onCommands?.(
      (['image', 'media'] as const).map((type) => ({
        id: `${type}Properties`,
        label: (labels as Partial<EditorMediaLabels>)[`${type}Properties`] ?? editorMediaLabels[`${type}Properties`],
        disabled: selected?.type !== type,
        run: () =>
          runtime.generation === generation &&
          isCurrent() &&
          !editor.isDestroyed &&
          editor.isEditable &&
          selected?.type === type
            ? (editorMediaRuntime(editor).properties.get(selected.id)?.() ?? false)
            : false,
      })),
    );
    return () => onCommands?.([]);
  }, [editor, labels, isCurrent, onCommands, selected, generation]);
  return null;
}

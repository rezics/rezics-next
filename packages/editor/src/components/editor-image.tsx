'use client';

import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldGroup, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import type { Editor, Extensions, Node } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import type { RichTextEditorLabels } from './editor-labels.ts';
import { imageTypes, trackPosition } from './editor-uploads.ts';
import { returnFocus } from './editor-menu-helpers.ts';
import { ImageUploadDialog } from './editor-upstream/reactjs-tiptap-editor/image-upload.tsx';

type ImageEditTarget = Pick<NodeViewProps, 'editor' | 'getPos' | 'node'>;

/** The editor displays an occurrence without fetching media or knowing the site's routes. */
function ImageView({
  node,
  editor,
  getPos,
  updateAttributes,
  labels,
}: NodeViewProps & { labels: RichTextEditorLabels }) {
  const [editing, setEditing] = useState(false);
  const [alt, setAlt] = useState('');
  const field = useId();
  const mounted = useRef(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const editTarget = useRef<ImageEditTarget | null>(null);
  const returnTarget = useRef<ImageEditTarget | null>(null);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      editTarget.current = null;
      returnTarget.current = null;
    };
  }, []);

  const nodeAtTarget = useCallback(
    (target: ImageEditTarget) => {
      if (!mounted.current || editor !== target.editor || editor.isDestroyed || !editor.isEditable) return null;
      try {
        const position = target.getPos();
        return typeof position === 'number' ? editor.state.doc.nodeAt(position) : null;
      } catch {
        return null;
      }
    },
    [editor],
  );
  const currentPosition = useCallback(
    (target: ImageEditTarget) => {
      if (!mounted.current || editor !== target.editor || editor.isDestroyed || !editor.isEditable) return null;
      try {
        const position = target.getPos();
        return typeof position === 'number' && editor.state.doc.nodeAt(position) === target.node ? position : null;
      } catch {
        return null;
      }
    },
    [editor],
  );

  function finishDescriptionEdit(apply: boolean) {
    const target = editTarget.current;
    editTarget.current = null;
    if (!target || currentPosition(target) === null) {
      returnTarget.current = null;
      setEditing(false);
      return;
    }

    if (apply) {
      updateAttributes({ alt });
      const updated = nodeAtTarget(target);
      if (!updated || updated.type !== target.node.type || updated.attrs.alt !== alt) {
        returnTarget.current = null;
        setEditing(false);
        return;
      }
      const sameOccurrence = Object.keys({ ...target.node.attrs, ...updated.attrs }).every(
        (key) => key === 'alt' || target.node.attrs[key] === updated.attrs[key],
      );
      if (!sameOccurrence) {
        returnTarget.current = null;
        setEditing(false);
        return;
      }
      returnTarget.current = { ...target, node: updated };
    } else {
      returnTarget.current = target;
    }
    setEditing(false);
  }

  useLayoutEffect(() => {
    if (editing) {
      const target = editTarget.current;
      if (target && currentPosition(target) === null) {
        editTarget.current = null;
        returnTarget.current = null;
        setEditing(false);
      }
      return;
    }

    const target = returnTarget.current;
    returnTarget.current = null;
    if (target && currentPosition(target) !== null) editButton.current?.focus();
  }, [currentPosition, editing, getPos, node]);

  return (
    <NodeViewWrapper
      contentEditable={false}
      className="flex flex-col gap-2 rounded-2xl border border-border p-3 font-sans text-sm"
    >
      <span role="img" aria-label={node.attrs.alt || labels.image}>
        {labels.image}: {node.attrs.alt}
      </span>
      {editor.isEditable ? (
        editing ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              finishDescriptionEdit(true);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                finishDescriptionEdit(false);
              }
            }}
          >
            <FieldGroup className="gap-2">
              <Field>
                <FieldLabel htmlFor={field}>{labels.imageAlt}</FieldLabel>
                <Input id={field} autoFocus value={alt} onChange={(event) => setAlt(event.target.value)} />
              </Field>
              <Field orientation="horizontal">
                <Button type="submit" variant="secondary">
                  {labels.apply}
                </Button>
                <Button type="button" variant="ghost" onClick={() => finishDescriptionEdit(false)}>
                  {labels.cancel}
                </Button>
              </Field>
            </FieldGroup>
          </form>
        ) : (
          <Button
            ref={editButton}
            type="button"
            variant="outline"
            className="self-start"
            onClick={() => {
              const target = { editor, getPos, node };
              if (editor.isDestroyed || !editor.isEditable || nodeAtTarget(target) !== node) return;
              editTarget.current = target;
              setAlt(node.attrs.alt ?? '');
              setEditing(true);
            }}
          >
            {labels.editImageAlt}
          </Button>
        )
      ) : null}
    </NodeViewWrapper>
  );
}

export function withImageView(extensions: Extensions, labels: () => RichTextEditorLabels): Extensions {
  return extensions.map((extension) =>
    extension.name === 'image'
      ? (extension as Node).extend({
          addNodeView() {
            return ReactNodeViewRenderer((props) => <ImageView {...props} labels={labels()} />);
          },
        })
      : extension,
  );
}

/** Product media presentation over the existing mapped insertion position and authorized upload port. */
export function ImageInsert({
  editor,
  position,
  labels,
  onInsert,
  onClose,
  isCurrent = () => true,
  isPositionCurrent = () => true,
}: {
  editor: Editor;
  position: number;
  labels: RichTextEditorLabels;
  onInsert: (files: File[], position: number, alt: string) => void;
  onClose: () => void;
  isCurrent?: () => boolean;
  isPositionCurrent?: (position: number) => boolean;
}) {
  const tracked = useRef<ReturnType<typeof trackPosition> | null>(null);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    tracked.current = trackPosition(editor, position);
    return () => {
      mounted.current = false;
      tracked.current?.stop();
      tracked.current = null;
    };
  }, [editor, position]);
  const current = () =>
    mounted.current &&
    isCurrent() &&
    !editor.isDestroyed &&
    editor.isEditable &&
    tracked.current !== null &&
    isPositionCurrent(tracked.current.get());
  const close = () => {
    if (!current()) return;
    onClose();
    returnFocus(editor, () => !editor.isDestroyed && editor.isEditable && isCurrent())();
  };
  return (
    <ImageUploadDialog
      labels={labels}
      accept={imageTypes.join(',')}
      isCurrent={current}
      onCancel={close}
      onInsert={(file, alt) => {
        if (!current() || editor.view.composing) return;
        const target = tracked.current?.get();
        if (target === undefined) return;
        onInsert([file], target, alt);
        close();
      }}
    />
  );
}

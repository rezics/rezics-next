'use client';

import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldGroup, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import type { Editor, Extensions, Node } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { RichTextEditorLabels } from './editor-labels.ts';
import { imageTypes, trackPosition } from './editor-uploads.ts';

/** The editor displays an occurrence without fetching media or knowing the site's routes. */
function ImageView({ node, editor, updateAttributes, labels }: NodeViewProps & { labels: RichTextEditorLabels }) {
  const [editing, setEditing] = useState(false);
  const [alt, setAlt] = useState('');
  const field = useId();
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
              updateAttributes({ alt });
              setEditing(false);
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
                <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                  {labels.cancel}
                </Button>
              </Field>
            </FieldGroup>
          </form>
        ) : (
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={() => {
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

/**
 * Choose a file, then describe it before starting its upload. The panel stays in the editor's flow rather than in a
 * popover portal, so the file chooser and the description belong to the editor that asked for them.
 */
export function ImageInsert({
  editor,
  position,
  labels,
  onInsert,
  onClose,
}: {
  editor: Editor;
  position: number;
  labels: RichTextEditorLabels;
  onInsert: (files: File[], position: number, alt: string) => void;
  onClose: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [alt, setAlt] = useState('');
  const tracked = useRef<ReturnType<typeof trackPosition> | null>(null);
  const field = useId();
  useLayoutEffect(() => {
    tracked.current = trackPosition(editor, position);
    return () => {
      tracked.current?.stop();
    };
  }, [editor, position]);
  return (
    <div
      role="dialog"
      aria-label={labels.image}
      className="mt-2 rounded-2xl bg-popover p-3 text-popover-foreground shadow-lg ring-1 ring-foreground/5 dark:ring-foreground/10"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
          editor.commands.focus();
        }
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (file && editor.isEditable) {
            onInsert([file], tracked.current?.get() ?? position, alt);
            onClose();
          }
        }}
      >
        <FieldGroup className="gap-3">
          <Field>
            <FieldLabel htmlFor={`${field}-file`}>{labels.uploadFile}</FieldLabel>
            <Input
              id={`${field}-file`}
              autoFocus
              type="file"
              accept={imageTypes.join(',')}
              onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={field}>{labels.imageAlt}</FieldLabel>
            <Input id={field} value={alt} onChange={(event) => setAlt(event.target.value)} />
          </Field>
          <Field orientation="horizontal">
            <Button type="submit" disabled={!file || !editor.isEditable}>
              {labels.insertImage}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                onClose();
                editor.commands.focus();
              }}
            >
              {labels.cancel}
            </Button>
          </Field>
        </FieldGroup>
      </form>
    </div>
  );
}

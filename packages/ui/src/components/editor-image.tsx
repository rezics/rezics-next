'use client';

import type { Editor, Extensions, Node } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from './button.tsx';
import { Input } from './input.tsx';
import type { RichTextEditorLabels } from './editor-labels.ts';
import { imageTypes, trackPosition } from './editor-uploads.ts';

/** The editor displays an occurrence without fetching media or knowing the site's routes. */
function ImageView({ node, editor, updateAttributes, labels }: NodeViewProps & { labels: RichTextEditorLabels }) {
  const [editing, setEditing] = useState(false);
  const [alt, setAlt] = useState('');
  const field = useId();
  return (
    <NodeViewWrapper contentEditable={false} className="rounded-xl border border-border p-3">
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
            <label htmlFor={field}>{labels.imageAlt}</label>
            <Input id={field} autoFocus value={alt} onChange={(event) => setAlt(event.target.value)} />
            <Button type="submit">{labels.apply}</Button>
            <Button type="button" onClick={() => setEditing(false)}>
              {labels.cancel}
            </Button>
          </form>
        ) : (
          <Button
            type="button"
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

/** Choose a file, then describe it before starting its upload. */
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
  useEffect(() => {
    tracked.current = trackPosition(editor, position);
    return () => {
      tracked.current?.stop();
    };
  }, [editor, position]);
  return (
    <div
      role="dialog"
      aria-label={labels.image}
      className="mt-2 rounded-xl border border-border bg-popover p-3"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
          editor.commands.focus();
        }
      }}
    >
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (file) {
            onInsert([file], tracked.current?.get() ?? position, alt);
            onClose();
          }
        }}
      >
        <label htmlFor={`${field}-file`}>{labels.uploadFile}</label>
        <input
          id={`${field}-file`}
          autoFocus
          type="file"
          accept={imageTypes.join(',')}
          onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
        />
        <label htmlFor={field}>{labels.imageAlt}</label>
        <Input id={field} value={alt} onChange={(event) => setAlt(event.target.value)} />
        <Button type="submit" disabled={!file}>
          {labels.insertImage}
        </Button>
        <Button
          type="button"
          onClick={() => {
            onClose();
            editor.commands.focus();
          }}
        >
          {labels.cancel}
        </Button>
      </form>
    </div>
  );
}

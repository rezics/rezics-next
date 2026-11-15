'use client';

import type { Editor } from '@tiptap/core';
import { useLayoutEffect, useRef } from 'react';
import type { RichTextEditorLabels } from './editor-labels.ts';
import { imageTypes, trackPosition } from './editor-uploads.ts';
import { returnFocus } from './editor-menu-helpers.ts';
import { ImageUploadDialog } from './editor-upstream/reactjs-tiptap-editor/image-upload.tsx';

export { withMediaViews, EditorMediaControls } from './editor-media-views.tsx';

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

import type { Editor } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import { closeHistory } from '@tiptap/pm/history';

export type MediaEditTarget = {
  editor: Editor;
  node: Node;
  getPos: () => number | undefined;
  generation?: number;
  currentGeneration?: () => number;
};
export type ImageProperties = {
  alt: string | null;
  title: string | null;
  width: number | null;
  height: number | null;
  conceal: boolean;
};

export function currentMediaPosition(target: MediaEditTarget, isCurrent: () => boolean): number | null {
  if (!isCurrent() || target.editor.isDestroyed || !target.editor.isEditable || target.editor.view.composing)
    return null;
  if (target.generation !== undefined && target.currentGeneration?.() !== target.generation) return null;
  try {
    const pos = target.getPos();
    return typeof pos === 'number' && target.editor.state.doc.nodeAt(pos) === target.node ? pos : null;
  } catch {
    return null;
  }
}

export function imageDimension(value: string): number | null | false {
  if (!value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : false;
}

export function applyImageProperties(
  target: MediaEditTarget,
  properties: ImageProperties,
  isCurrent: () => boolean,
): boolean {
  const pos = currentMediaPosition(target, isCurrent);
  if (
    pos === null ||
    target.node.type.name !== 'image' ||
    (properties.alt !== null && typeof properties.alt !== 'string') ||
    (properties.title !== null && typeof properties.title !== 'string') ||
    typeof properties.conceal !== 'boolean' ||
    [properties.width, properties.height].some((value) => value !== null && (!Number.isFinite(value) || value <= 0))
  )
    return false;
  const editor = target.editor;
  const before = editor.state;
  editor.view.dispatch(
    closeHistory(
      editor.state.tr.setNodeMarkup(pos, undefined, {
        ...target.node.attrs,
        alt: properties.alt,
        title: properties.title,
        width: properties.width,
        height: properties.height,
        conceal: properties.conceal,
      }),
    ),
  );
  return before !== editor.state;
}

export function applyMediaCaption(target: MediaEditTarget, caption: string, isCurrent: () => boolean): boolean {
  const pos = currentMediaPosition(target, isCurrent);
  if (pos === null || target.node.type.name !== 'media') return false;
  const editor = target.editor;
  const before = editor.state;
  editor.view.dispatch(closeHistory(editor.state.tr.setNodeMarkup(pos, undefined, { ...target.node.attrs, caption })));
  return before !== editor.state;
}

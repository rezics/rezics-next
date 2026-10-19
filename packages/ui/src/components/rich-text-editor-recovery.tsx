import { serializeDocument, type DocumentNode, type DocumentSnapshot } from '@rezics/document';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { editorSnapshot } from './rich-text-editor-snapshot.ts';

/** Editor-owned recovery can violate portable validation. Hydrate its raw nodes; only a successful snapshot may be published. */
export function readEditorRecovery(value?: string): DocumentNode | undefined {
  if (!value) return;
  try {
    const retained = JSON.parse(value) as Partial<DocumentSnapshot> | null;
    if (retained?.version === 'rezics-document-v1' && (retained.profile === 'blocks' || retained.profile === 'text') && retained.doc?.type === 'doc')
      return retained.doc;
  } catch { /* Malformed storage is never interpreted as manuscript text. */ }
}

export function sameEditorBlocks(a: DocumentSnapshot, b: DocumentSnapshot): boolean {
  const left = a.doc.content ?? [], right = b.doc.content ?? [];
  return a === b || (a.profile === b.profile && left.length === right.length && left.every((block, index) => block === right[index]));
}

/** Controlled input is compared with the last successful emission before replacing live content. */
export function controlledEditorContent(
  value: DocumentSnapshot,
  lastEmitted: DocumentSnapshot | null,
  current: ProseMirrorNode,
  recovery?: DocumentNode,
): DocumentNode | undefined {
  if (recovery) return current.eq(current.type.schema.nodeFromJSON(recovery)) ? undefined : recovery;
  if (lastEmitted && (sameEditorBlocks(value, lastEmitted) || serializeDocument(value) === serializeDocument(lastEmitted))) return;
  return value.doc;
}

export function removeEditorImages(state: EditorState, invalidOnly = false): Transaction {
  const images: Array<{ from: number; to: number }> = [];
  state.doc.descendants((node, position) => {
    if (node.type.name !== 'image') return;
    if (invalidOnly) {
      try {
        editorSnapshot(state.doc.type.create(null, node), 'blocks', new WeakMap());
        return;
      } catch { /* Remove only the images that cannot enter a complete snapshot. */ }
    }
    images.push({ from: position, to: position + node.nodeSize });
  });
  const transaction = state.tr;
  for (const image of images.reverse()) transaction.delete(image.from, image.to);
  return transaction;
}

import {
  documentVersion,
  normalizeDocument,
  withDocumentIds,
  type DocumentNode,
  type DocumentProfile,
  type DocumentSnapshot,
} from '@rezics/document';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { assertJsonByteBudget } from './editor-json-budget.ts';

export const maxSnapshotBytes = 2 * 1024 * 1024;

function wireNode(node: DocumentNode): DocumentNode {
  const attrs =
    node.type === 'image' && node.attrs
      ? Object.fromEntries(Object.entries(node.attrs).filter(([name]) => name !== 'variant'))
      : node.attrs;
  return {
    ...node,
    ...(attrs ? { attrs } : {}),
    ...(node.content ? { content: node.content.map(wireNode) } : {}),
  };
}

export function assertSnapshotSize(snapshot: DocumentSnapshot): void {
  assertJsonByteBudget(snapshot, maxSnapshotBytes);
}

/** Convert one editor state to a validated document snapshot. */
export function editorSnapshot(doc: ProseMirrorNode, profile: DocumentProfile): DocumentSnapshot {
  const content = wireNode(doc.toJSON() as DocumentNode);
  const candidate: DocumentSnapshot = {
    version: documentVersion,
    profile,
    doc: withDocumentIds(content),
  };
  assertSnapshotSize(candidate);
  const snapshot = normalizeDocument(candidate);

  assertSnapshotSize(snapshot);
  return snapshot;
}

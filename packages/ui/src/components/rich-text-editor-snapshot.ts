import { normalizeDocument, withDocumentIds, type DocumentNode, type DocumentSnapshot } from '@rezics/document';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

/** Snapshot live content without consulting image delivery or metadata. Errors belong to the owner. */
export function editorSnapshot(doc: ProseMirrorNode, profile: DocumentSnapshot['profile'], blocks: WeakMap<ProseMirrorNode, DocumentNode>): DocumentSnapshot {
  const nodes: ProseMirrorNode[] = [];
  const content: DocumentNode[] = [];
  doc.forEach(node => { nodes.push(node); content.push(blocks.get(node) ?? node.toJSON() as DocumentNode); });
  let next: DocumentSnapshot;
  try {
    next = normalizeDocument({ version: 'rezics-document-v1', profile, doc: { type: 'doc', content } });
  } catch {
    next = normalizeDocument({ version: 'rezics-document-v1', profile, doc: withDocumentIds(doc.toJSON() as DocumentNode) });
  }
  nodes.forEach((node, index) => blocks.set(node, next.doc.content![index]!));
  return next;
}

import { normalizeDocument, type DocumentNode, type DocumentSnapshot } from '@rezics/document';
import {
  knowledgeMediaSource,
  parseKnowledgeMediaSource,
  type KnowledgeMediaSelection,
} from '@rezics/definitions/knowledge-media';
import { KnowledgeInvalidInputError } from './knowledge-model.ts';

/** Only authored bare managed locators request a claim in the saved revision. */
export function collectKnowledgeMediaIds(snapshot: DocumentSnapshot): readonly string[] {
  const ids = new Set<string>();
  const visit = (node: DocumentNode): void => {
    if (node.type === 'image' || node.type === 'media') {
      const source = parseKnowledgeMediaSource(node.attrs?.src);
      if (source?.selection === null) ids.add(source.mediaId);
      if (ids.size > 32) throw new KnowledgeInvalidInputError();
    }
    for (const child of node.content ?? []) visit(child);
  };
  visit(snapshot.doc);
  return [...ids].sort();
}

/** Copy keeps each image's independent source authority instead of claiming its bytes anew. */
export function contextualizeKnowledgeCopyMedia(
  snapshot: DocumentSnapshot,
  selection: KnowledgeMediaSelection,
): DocumentSnapshot {
  const rewrite = (node: DocumentNode): DocumentNode => {
    const source =
      node.type === 'image' || node.type === 'media' ? parseKnowledgeMediaSource(node.attrs?.src) : null;
    return {
      ...node,
      ...(source?.selection === null
        ? { attrs: { ...node.attrs, src: knowledgeMediaSource(source.mediaId, selection) } }
        : {}),
      ...(node.content ? { content: node.content.map(rewrite) } : {}),
    };
  };
  return normalizeDocument({ ...snapshot, doc: rewrite(snapshot.doc) });
}

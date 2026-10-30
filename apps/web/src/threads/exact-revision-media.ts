import type { KernelClient } from '@rezics/client';
import type { DocumentNode, DocumentSnapshot } from '@rezics/document';

/** Consumer-local absence boundary until the original document-media module is delivered. */
export type RevisionDocumentMedia = Readonly<{ kind: 'unavailable' }>;

type RevisionImageSource = Readonly<{
  availability: string;
  body: DocumentSnapshot | null;
  mediaIds: readonly string[];
}>;

/** Only original IDs declared by, and actually referenced in, this delivered document page. */
export function revisionDocumentImageIds(revisions: readonly RevisionImageSource[]): string[] {
  const ids = new Set<string>();
  for (const revision of revisions) {
    if (revision.availability !== 'available' || !revision.body) continue;
    const declared = new Set(revision.mediaIds);
    const visit = (node: DocumentNode) => {
      if (ids.size === 32) return;
      if (node.type === 'image' && typeof node.attrs?.src === 'string' && declared.has(node.attrs.src))
        ids.add(node.attrs.src);
      for (const child of node.content ?? []) {
        if (ids.size === 32) break;
        visit(child);
      }
    };
    visit(revision.body.doc);
    if (ids.size === 32) break;
  }
  return [...ids];
}

/**
 * No native caller or image renderer belongs here. Replace this boundary with the original
 * document-media loadDocumentMedia export when it exists; absence grants no media authority.
 */
export async function loadRevisionDocumentMedia(
  _client: KernelClient,
  _ids: readonly string[],
  _authorization: string | null = null,
): Promise<RevisionDocumentMedia> {
  return { kind: 'unavailable' };
}

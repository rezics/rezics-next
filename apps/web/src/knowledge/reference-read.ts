import type { KernelClient } from '@rezics/client';
import type { DocumentSnapshot } from '@rezics/document';
import { admitKnowledgePrivateHead } from './private-knowledge';
import { readKnowledgePublicDocument } from './public-read';
import { referenceBlock, type KnowledgeReferenceTarget } from './reference-model';

export type ReferenceInspection =
  | { state: 'ready'; documentId: string; revisionId: string; sha256: string; title: string; body: DocumentSnapshot }
  | { state: 'unavailable' | 'denied' | 'not-found' | 'retired' | 'signed-out' };
export type ReferenceInspectionRequest = {
  target: KnowledgeReferenceTarget;
  locale: string;
  /** A destination address is supplied explicitly; it never becomes citation provenance. */
  notebookId: string | null;
};
export type ReferenceInspector = (input: ReferenceInspectionRequest) => Promise<ReferenceInspection>;

/** One explicit selected target. There is no fallback, recursion, metadata prefetch or registry. */
export async function inspectKnowledgeReference(
  client: KernelClient,
  input: ReferenceInspectionRequest,
  privateAccess?: { accountId: string; authorization: string },
): Promise<ReferenceInspection> {
  const target = input.target;
  if (target.kind === 'subject') return { state: 'unavailable' };
  let document: { documentId: string; revisionId: string; sha256?: string; title: string; body: DocumentSnapshot };
  if (input.notebookId !== null) {
    if (!privateAccess) return { state: 'denied' };
    const address = { accountId: privateAccess.accountId, notebookId: input.notebookId, documentId: target.documentId };
    const result = await client
      .accounts({ accountId: address.accountId })
      .knowledge.notebooks({ notebookId: address.notebookId })
      .documents({ documentId: target.documentId })
      .get({
        query: target.kind === 'revision' ? { revisionId: target.revisionId } : {},
        headers: { authorization: privateAccess.authorization },
        fetch: { cache: 'no-store', redirect: 'manual' },
      });
    const admitted = await admitKnowledgePrivateHead(result.status, result.data, address);
    if (admitted.state !== 'ready') return { state: admitted.state };
    document = admitted.head;
  } else {
    const result = await readKnowledgePublicDocument(client, {
      documentId: target.documentId,
      revisionId: target.kind === 'revision' ? target.revisionId : null,
      locale: input.locale,
    });
    if (result.state !== 'ready') return { state: result.state === 'preparing' ? 'unavailable' : result.state };
    document = result.document;
  }
  if (
    target.kind === 'revision' &&
    (document.revisionId !== target.revisionId ||
      document.sha256 !== target.sha256 ||
      (target.blockId !== undefined && !referenceBlock(document.body, target.blockId)))
  )
    return { state: 'unavailable' };
  return {
    state: 'ready',
    documentId: document.documentId,
    revisionId: document.revisionId,
    sha256: document.sha256!,
    title: document.title,
    body: document.body,
  };
}

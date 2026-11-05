import { serializeDocument, type DocumentNode, type DocumentSnapshot } from '@rezics/document';
import { UUID } from '../checkout/price';
import { parseEditionMetadata, parseEditionRevision, type EditionApi, type EditionMetadata } from './edition-api';
import type { DocumentImagePresentation, DocumentMediaRead } from './edition-media';

export type EditionSubject = { id: string; label: string };
export type EditionCreator = { id: string; name: string };
export type EditionContext = {
  subject(id: string): Promise<EditionSubject | null>;
  creator(id: string): Promise<EditionCreator | null>;
  media?(ids: readonly string[], authorization: string): Promise<DocumentMediaRead>;
};
export type ContentEditionState =
  | { state: 'loading' }
  | { state: 'refused'; status: 401 | 403 }
  | { state: 'unavailable'; status: number; reason: 'native-pending' | 'source' | 'dependency' | 'not-published' }
  | { state: 'withdrawn'; status: 410 }
  | { state: 'version-mismatch'; status: 502 }
  | {
      state: 'published';
      metadata: EditionMetadata;
      body: DocumentSnapshot;
      subject: EditionSubject | null;
      creator: EditionCreator | null;
      media: { kind: 'ready'; images: readonly DocumentImagePresentation[] } | { kind: 'unavailable' };
    };

/** Original image references in this one delivered document; overflow never starts a partial/refill read. */
function documentImageIds(body: DocumentSnapshot): string[] | null {
  const ids = new Set<string>();
  const visit = (node: DocumentNode): boolean => {
    const id = node.attrs?.src;
    if (node.type === 'image' && typeof id === 'string' && UUID.test(id)) ids.add(id);
    return ids.size <= 32 && (node.content ?? []).every(visit);
  };
  return visit(body.doc) ? [...ids] : null;
}

async function readMedia(
  body: DocumentSnapshot,
  authorization: string,
  context?: EditionContext,
): Promise<Extract<ContentEditionState, { state: 'published' }>['media']> {
  const ids = documentImageIds(body);
  if (!ids) return { kind: 'unavailable' };
  if (!ids.length) return { kind: 'ready', images: [] };
  if (!context?.media) return { kind: 'unavailable' };
  try {
    const result = await context.media(ids, authorization);
    if (result.kind !== 'ready') return { kind: 'unavailable' };
    // Omission is only unavailability. Ignore unrelated entries and retain exact original IDs.
    const images = ids.flatMap((id) => {
      const image = result.images.get(id);
      return image?.id === id ? [image] : [];
    });
    return { kind: 'ready', images };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** Native post digests cover the canonical document bytes, not JSON.stringify's object order. */
export async function editionDocumentDigest(body: DocumentSnapshot): Promise<string> {
  const bytes = new TextEncoder().encode(serializeDocument(body));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Two exact source reads; optional identity points cannot authorize or substitute for either of them. */
export async function loadContentEdition(
  api: EditionApi,
  editionId: string,
  authorization: string | null,
  context?: EditionContext,
): Promise<ContentEditionState> {
  if (!authorization) return { state: 'refused', status: 401 };
  try {
    const current = await api.readMetadata(editionId, authorization);
    if (current.state !== 'available') return current;
    const metadata = parseEditionMetadata(current.value);
    if (!metadata || metadata.editionId !== editionId) return { state: 'version-mismatch', status: 502 };
    if (metadata.state === 'withdrawn') return { state: 'withdrawn', status: 410 };
    if (metadata.state !== 'published') return { state: 'unavailable', status: 404, reason: 'not-published' };

    const source = await api.readRevision(editionId, authorization);
    if (source.state !== 'available') return source;
    const revision = parseEditionRevision(source.value);
    if (
      !revision ||
      revision.editionId !== editionId ||
      revision.revisionId !== metadata.revisionId ||
      revision.sha256 !== metadata.sha256 ||
      revision.licence !== metadata.licence ||
      (await editionDocumentDigest(revision.body)) !== metadata.sha256
    )
      return { state: 'version-mismatch', status: 502 };

    const [subject, creator, media] = await Promise.allSettled([
      context?.subject(metadata.targetSubjectId),
      context?.creator(metadata.creatorAccountId),
      readMedia(revision.body, authorization, context),
    ]);
    return {
      state: 'published',
      metadata,
      body: revision.body,
      subject: subject?.status === 'fulfilled' && subject.value?.id === metadata.targetSubjectId ? subject.value : null,
      creator:
        creator?.status === 'fulfilled' && creator.value?.id === metadata.creatorAccountId ? creator.value : null,
      media: media.status === 'fulfilled' ? media.value : { kind: 'unavailable' },
    };
  } catch {
    return { state: 'unavailable', status: 503, reason: 'dependency' };
  }
}

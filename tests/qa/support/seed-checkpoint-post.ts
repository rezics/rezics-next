import { fromPlainText } from '@rezics/document';
import type { CorpusApi } from '../../../scripts/load/work-profile-corpus.ts';
import type { SeedPost } from './seed-checkpoints.ts';

/** A public, independently authored Post outside every measured Collection/Zone. */
export async function seedCheckpointPost(api: CorpusApi, actor: string, index: number): Promise<SeedPost> {
  const key = `checkpoint:post:${index}`;
  const document = fromPlainText(`Checkpoint unrelated Post text ${index}`, 'blocks');
  const post = await api.command<SeedPost>(`${key}:create`, { method: 'POST', path: '/v1/posts', body: {
    profile: 'authored-post-v1', actingSubject: actor, language: 'en', document,
    title: { value: `Checkpoint unrelated Post ${index}`, language: 'en' },
  } });
  const draft = await api.command<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
    `${key}:draft`, { method: 'POST', path: '/v1/content-drafts', body: {
      profile: 'content-text-v1', resourceId: post.post, variantId: post.variantId,
      expectedHead: post.revisionId, document, actingSubject: actor,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
    } });
  const publication = await api.command<{ status: string; decision: string }>(`${key}:publish`, {
    method: 'POST', path: '/v1/content-publications', body: {
      profile: 'content-publication-v1', preparationId: `${key}:publication`,
      resourceId: post.post, variantId: post.variantId, revisionId: draft.revisionId,
      expectedDigest: draft.byteDigest, expectedContentEpoch: draft.sourcePosition.dataEpoch,
      expectedPublicationHead: null, actingSubject: actor,
    },
  });
  if (publication.status !== 'active') throw new Error('Checkpoint Post publication is incomplete');
  await api.command(`${key}:search`, { method: 'POST', path: '/v1/content-search-eligibility', body: {
    profile: 'content-search-eligibility-v1', resourceId: post.post, variantId: post.variantId,
    publicationDecision: publication.decision, expectedEligibilityHead: null,
    rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor,
  } });
  return { ...post, revisionId: draft.revisionId, byteDigest: draft.byteDigest };
}

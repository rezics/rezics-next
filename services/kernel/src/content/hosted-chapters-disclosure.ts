import { createHash } from 'node:crypto';
import { serializeDocument } from '@rezics/document';
import type { ReadContext } from './model.ts';
import { MAX_DOCUMENT_BYTES } from './document.ts';
import { ContentNotFoundError, readPost, type PostEntry, type RetainContentRead } from './reads.ts';
import type { HostedChapterTarget, HostedDependencies } from './hosted-chapters-model.ts';

type AvailablePost = Extract<PostEntry, { availability: 'available' }>;

function matches(value: PostEntry | null, target: HostedChapterTarget): value is AvailablePost {
  return (
    value?.availability === 'available' &&
    value.id === target.postId &&
    value.threadId === target.threadId &&
    value.revisionId === target.revisionId &&
    value.sha256 === target.sha256
  );
}

/** Retain native source authority, not a new head read that could bless older bytes.
 * Page callers retain this handle and metadata only; bodies die at each observation. */
export async function prepareHostedTarget(deps: HostedDependencies, target: HostedChapterTarget, context: ReadContext) {
  const observation: { current?: Parameters<RetainContentRead<PostEntry>>[0] } = {};
  let original: { authorId: string; licence: string };
  try {
    const initial = await readPost(deps, target.threadId, target.postId, context, target.revisionId, (check) => {
      observation.current = check;
    });
    if (!matches(initial.value, target) || !observation.current) return null;
    original = { authorId: initial.value.authorId, licence: initial.value.licence };
  } catch (error) {
    if (error instanceof ContentNotFoundError) return null;
    throw error;
  }
  const retained = observation.current;
  if (!retained) return null;
  return {
    async final(includeBody = false) {
      const result = await retained().catch((error: unknown) => {
        if (error instanceof ContentNotFoundError) return null;
        throw error;
      });
      if (!result) return null;
      if (
        !matches(result.value, target) ||
        result.value.authorId !== original.authorId ||
        result.value.licence !== original.licence
      )
        return null;
      if (!includeBody) return { ...original, canonicalBytes: null, anchor: result.anchor };
      const bytes = Buffer.from(serializeDocument(result.value.body), 'utf8');
      if (bytes.length > MAX_DOCUMENT_BYTES || createHash('sha256').update(bytes).digest('hex') !== target.sha256)
        return null;
      return { ...original, canonicalBytes: bytes.toString('base64'), anchor: result.anchor };
    },
  };
}

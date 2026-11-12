import { createHash } from 'node:crypto';
import { serializeDocument } from '@rezics/document';
import type { ReadContext } from './model.ts';
import { MAX_DOCUMENT_BYTES } from './document.ts';
import {
  ContentNotFoundError,
  readPost,
  readPostMetadata,
  type NativePostMetadata,
  type RetainContentRead,
} from './reads.ts';
import type { HostedChapterTarget, HostedDependencies } from './hosted-chapters-model.ts';

type TargetIdentity = Pick<NativePostMetadata, 'id' | 'threadId' | 'revisionId' | 'sha256'>;

function matches(value: TargetIdentity | null, target: HostedChapterTarget): boolean {
  return (
    value !== null &&
    value.id === target.postId &&
    value.threadId === target.threadId &&
    value.revisionId === target.revisionId &&
    value.sha256 === target.sha256
  );
}

/** A different thread must never borrow a valid placement's disclosure. */
export function hostedTargetKey(target: HostedChapterTarget): string {
  return `${target.threadId}/${target.postId}/${target.revisionId}/${target.sha256}`;
}

/** Retain the original native source and prepared ancestry/Access checks across
 * page work. Both observations select metadata only; a fresh head observation
 * cannot replace this handle, even when the requested revision still exists. */
export async function prepareHostedTargetMetadata(
  deps: HostedDependencies,
  target: HostedChapterTarget,
  context: ReadContext,
) {
  const observation: { current?: Parameters<RetainContentRead<NativePostMetadata>>[0] } = {};
  try {
    const initial = await readPostMetadata(
      deps,
      target.threadId,
      target.postId,
      context,
      target.revisionId,
      (current) => {
        observation.current = current;
      },
    );
    if (!initial.value || !matches(initial.value, target) || !observation.current) return null;
    const original = { authorId: initial.value.authorId, licence: initial.value.licence };
    const retained = observation.current;
    return {
      async final() {
        try {
          const result = await retained();
          if (
            !result.value ||
            !matches(result.value, target) ||
            result.value.authorId !== original.authorId ||
            result.value.licence !== original.licence
          )
            return null;
          return { ...original, anchor: result.anchor };
        } catch (error) {
          if (error instanceof ContentNotFoundError) return null;
          throw error;
        }
      },
    };
  } catch (error) {
    if (error instanceof ContentNotFoundError) return null;
    throw error;
  }
}

/** Exact opening fetches one document through ordinary Post disclosure, then
 * closes the original metadata observation. Metadata alone never proves bytes. */
export async function prepareHostedTarget(deps: HostedDependencies, target: HostedChapterTarget, context: ReadContext) {
  const guard = await prepareHostedTargetMetadata(deps, target, context);
  if (!guard) return null;
  return {
    async final() {
      try {
        const result = await readPost(deps, target.threadId, target.postId, context, target.revisionId);
        const post = result.value;
        if (post?.availability !== 'available' || !matches(post, target)) return null;
        const bytes = Buffer.from(serializeDocument(post.body), 'utf8');
        if (bytes.length > MAX_DOCUMENT_BYTES || createHash('sha256').update(bytes).digest('hex') !== target.sha256)
          return null;
        const current = await guard.final();
        if (!current || post.authorId !== current.authorId || post.licence !== current.licence) return null;
        return { ...current, canonicalBytes: bytes.toString('base64') };
      } catch (error) {
        if (error instanceof ContentNotFoundError) return null;
        throw error;
      }
    },
  };
}

/** Library checkpoints and occurrence metadata share the page disclosure contract. */
export async function discloseHostedTargetMetadata(
  deps: HostedDependencies,
  target: HostedChapterTarget,
  context: ReadContext,
) {
  const guard = await prepareHostedTargetMetadata(deps, target, context);
  return (await guard?.final()) ?? null;
}

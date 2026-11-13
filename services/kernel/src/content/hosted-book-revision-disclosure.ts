import { createHash } from 'node:crypto';
import { serializeDocument } from '@rezics/document';
import { ContentNotFoundError } from './commands.ts';
import type { AnchoredPosition, ReadContext } from './model.ts';
import {
  observeIssuedRevisionDisclosure,
  revisionDisclosureReaderGate,
  type RevisionDisclosureMembership,
  type RevisionDisclosureReaderGate,
} from './revision-disclosure.ts';
import {
  ContentNotFoundError as ReadNotFoundError,
  readBookScopedPost,
  readBookScopedPostMetadata,
  type NativePostMetadata,
} from './reads.ts';
import type { HostedChapterTarget, HostedDependencies } from './hosted-chapters-model.ts';
import { MAX_DOCUMENT_BYTES } from './document.ts';
import { discloseHostedTargetMetadata, prepareHostedTarget } from './hosted-chapters-disclosure.ts';

export type HostedBookTargetDocument = Readonly<{
  anchor: AnchoredPosition;
  canonicalBytes: string;
  authorId: string;
  licence: string;
}>;

function sameTarget(left: HostedChapterTarget, right: HostedChapterTarget): boolean {
  return (
    left.threadId === right.threadId &&
    left.postId === right.postId &&
    left.revisionId === right.revisionId &&
    left.sha256 === right.sha256
  );
}

function metadataMatches(value: NativePostMetadata | null, target: HostedChapterTarget): value is NativePostMetadata {
  return (
    value !== null &&
    value.id === target.postId &&
    value.threadId === target.threadId &&
    value.revisionId === target.revisionId &&
    value.sha256 === target.sha256
  );
}

async function issuedGate(
  deps: HostedDependencies,
  target: HostedChapterTarget,
  membership: RevisionDisclosureMembership,
  context: ReadContext,
): Promise<RevisionDisclosureReaderGate | null> {
  const observation = await observeIssuedRevisionDisclosure(
    deps,
    { catalogueId: membership.catalogueId, target },
    { deadline: context.deadline },
  );
  if (!observation || !sameTarget(observation.target, target)) return null;
  return revisionDisclosureReaderGate(observation, membership);
}

/** Public targets keep ordinary Content disclosure. A private target can
 * expose metadata only after the Book has selected this exact occurrence and
 * Content observes its current scoped consent and native source chain. */
export async function discloseHostedBookTargetMetadata(
  deps: HostedDependencies,
  target: HostedChapterTarget,
  membership: RevisionDisclosureMembership,
  context: ReadContext,
) {
  const ordinary = await discloseHostedTargetMetadata(deps, target, context);
  if (ordinary) return ordinary;

  const gate = await issuedGate(deps, target, membership, context);
  if (!gate) return null;
  try {
    const disclosed = await readBookScopedPostMetadata(deps, membership.catalogueId, target, gate, context);
    if (!metadataMatches(disclosed.value, target) || disclosed.value.documentKind !== 'opening') return null;
    return { anchor: disclosed.anchor };
  } catch (error) {
    if (error instanceof ContentNotFoundError || error instanceof ReadNotFoundError) return null;
    throw error;
  }
}

/** Resolve one exact body through the native Content reader after Book
 * membership has already selected the immutable publication occurrence. */
export async function readHostedBookTarget(
  deps: HostedDependencies,
  target: HostedChapterTarget,
  membership: RevisionDisclosureMembership,
  context: ReadContext,
): Promise<HostedBookTargetDocument | null> {
  const ordinary = await prepareHostedTarget(deps, target, context);
  const publicOrAuthor = await ordinary?.final();
  if (publicOrAuthor?.canonicalBytes) return publicOrAuthor;

  const gate = await issuedGate(deps, target, membership, context);
  if (!gate) return null;
  try {
    const disclosed = await readBookScopedPost(deps, membership.catalogueId, target, gate, context);
    const post = disclosed.value;
    if (
      !post ||
      post.availability !== 'available' ||
      post.id !== target.postId ||
      post.threadId !== target.threadId ||
      post.revisionId !== target.revisionId ||
      post.sha256 !== target.sha256 ||
      !post.body
    )
      return null;
    const bytes = Buffer.from(serializeDocument(post.body), 'utf8');
    if (bytes.length > MAX_DOCUMENT_BYTES || createHash('sha256').update(bytes).digest('hex') !== target.sha256)
      return null;
    return {
      anchor: disclosed.anchor,
      canonicalBytes: bytes.toString('base64'),
      authorId: post.authorId,
      licence: post.licence,
    };
  } catch (error) {
    if (error instanceof ContentNotFoundError || error instanceof ReadNotFoundError) return null;
    throw error;
  }
}

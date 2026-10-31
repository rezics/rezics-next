import type { KernelClient } from '@rezics/client';
import { checkDocument, type DocumentNode, type DocumentSnapshot } from '@rezics/document';
import { notFound } from '@tanstack/react-router';
import { readPageAuthors, type PageAuthor } from '../identity/read';
import type { ReadCredentialMode } from '../kernel/credential';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';

const contentId = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type ReplyParentInput = { threadId: string; parentId: string; credentialMode: ReadCredentialMode };
export type ReplyParentResult =
  | { state: 'unavailable' }
  | {
      state: 'available';
      id: string;
      threadId: string;
      excerpt: string;
      licence: string;
      revisionId?: string;
      author?: PageAuthor;
    };

export function validateReplyParentInput(input: unknown): ReplyParentInput {
  if (
    !input ||
    typeof input !== 'object' ||
    !('threadId' in input) ||
    typeof input.threadId !== 'string' ||
    !contentId.test(input.threadId) ||
    !('parentId' in input) ||
    typeof input.parentId !== 'string' ||
    !contentId.test(input.parentId) ||
    !('credentialMode' in input) ||
    (input.credentialMode !== 'anonymous' && input.credentialMode !== 'session')
  )
    throw notFound();
  return { threadId: input.threadId, parentId: input.parentId, credentialMode: input.credentialMode };
}

const textContainers = new Set([
  'doc',
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'codeBlock',
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
  'ruby',
]);

/** A bounded plain-text projection, never a second document renderer. React escapes the result. */
export function replyParentExcerpt(document: DocumentSnapshot): string {
  let text = '';
  let remaining = 512;
  function visit(node: DocumentNode, depth: number) {
    if (--remaining < 0 || depth > 32 || text.length >= 241) return;
    // Concealed writing and images (including alt text) cannot enter the preview.
    if (node.marks?.some((mark) => mark.type === 'spoiler') || node.attrs?.conceal) return;
    if (node.type === 'text') text += (node.text ?? '').slice(0, 241 - text.length);
    else if (node.type === 'hardBreak') text += ' ';
    else if (textContainers.has(node.type)) {
      for (const child of node.content ?? []) {
        visit(child, depth + 1);
        if (remaining <= 0 || text.length >= 241) break;
      }
      if (node.type !== 'ruby') text += ' ';
    }
  }
  visit(document.doc, 0);
  text = text.replace(/\s+/gu, ' ').trim();
  return text.length > 240 ? `${text.slice(0, 240).trimEnd()}…` : text;
}

/** One ordinary current post read. A relation is an address, never disclosure authority. */
export async function loadReplyParent(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: ReplyParentInput,
): Promise<ReplyParentResult> {
  const data = validateReplyParentInput(input);
  try {
    let authorization: string | null = null;
    if (data.credentialMode === 'session') {
      await prepareSession(request, sessionEnv);
      authorization = viewerCredential(request);
      // Failed/absent signed-in authority must not become an anonymous read.
      if (!authorization) return { state: 'unavailable' };
    }
    const result = await client.posts({ id: data.parentId }).get(authorization ? { headers: { authorization } } : {});
    const post = result.error ? undefined : result.data?.post;
    if (
      !post ||
      post.id !== data.parentId ||
      post.threadId !== data.threadId ||
      post.availability !== 'available' ||
      typeof post.licence !== 'string' ||
      !post.licence ||
      !checkDocument(post.body) ||
      (post.revisionId !== undefined && !contentId.test(post.revisionId))
    )
      return { state: 'unavailable' };
    const author =
      typeof post.authorId === 'string' && contentId.test(post.authorId)
        ? (await readPageAuthors(client, [post.authorId]))?.[post.authorId]
        : undefined;
    return {
      state: 'available',
      id: post.id,
      threadId: post.threadId,
      excerpt: replyParentExcerpt(post.body),
      licence: post.licence,
      ...(post.revisionId ? { revisionId: post.revisionId } : {}),
      ...(author ? { author } : {}),
    };
  } catch {
    return { state: 'unavailable' };
  }
}

import type { ExactRevisionIdentity } from './exact-revision';

/** The selected native revision identity is the address; there is no head or ordinal fallback. */
export function exactRevisionHref({ postId, revisionId }: ExactRevisionIdentity, locale: string): string {
  return `/${encodeURIComponent(locale)}/posts/${encodeURIComponent(postId)}/revisions/${encodeURIComponent(revisionId)}`;
}

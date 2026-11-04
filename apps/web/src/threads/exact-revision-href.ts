import type { ExactRevisionIdentity } from './exact-revision';

export type ExactRevisionRoute = {
  to: '/posts/$id/revisions/$revisionId';
  params: { id: string; revisionId: string };
  search: { historyReturn?: string };
};

/** The selected native revision identity is the address; there is no head or ordinal fallback. */
export function exactRevisionHref({ postId, revisionId }: ExactRevisionIdentity, locale: string): string {
  return `/${encodeURIComponent(locale)}/posts/${encodeURIComponent(postId)}/revisions/${encodeURIComponent(revisionId)}`;
}

/** Same-tab route intent. Immutable copy and new-tab links continue to use exactRevisionHref without a receipt. */
export function exactRevisionRoute(
  { postId, revisionId }: ExactRevisionIdentity,
  historyReturn?: string,
): ExactRevisionRoute {
  return {
    to: '/posts/$id/revisions/$revisionId',
    params: { id: postId, revisionId },
    search: historyReturn ? { historyReturn } : {},
  };
}

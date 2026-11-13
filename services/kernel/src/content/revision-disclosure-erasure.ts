import type { AccessClient } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import {
  REVISION_DISCLOSURE_ERASURE_PAGE,
  isRevisionDisclosureUuid,
  type RevisionDisclosureErasureContext,
  type RevisionDisclosureErasureItem,
  type RevisionDisclosureErasureLocator,
  type RevisionDisclosureErasurePage,
} from './revision-disclosure-model.ts';
import pagePost from './revision-disclosure-erasure-page.sql';
import pageThread from './revision-disclosure-thread-page.sql';

function boundLimit(limit: number | undefined): number {
  if (limit === undefined) return REVISION_DISCLOSURE_ERASURE_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > REVISION_DISCLOSURE_ERASURE_PAGE)
    throw new RangeError('Revision disclosure erasure page is at most 50');
  return limit;
}

function item(row: {
  disclosure_id: string;
  thread_id: string;
  post_id: string;
  revision_id: string;
  catalogue_id: string;
  revoked: boolean;
}): RevisionDisclosureErasureItem {
  return {
    disclosureId: row.disclosure_id,
    threadId: row.thread_id,
    postId: row.post_id,
    revisionId: row.revision_id,
    catalogueId: row.catalogue_id,
    revoked: row.revoked,
  };
}

function pageOf(rows: readonly RevisionDisclosureErasureItem[], limit: number): RevisionDisclosureErasurePage {
  const overflow = rows.length > limit;
  const items = overflow ? rows.slice(0, limit) : rows;
  return { items, next: overflow ? (items[items.length - 1]?.disclosureId ?? null) : null };
}

/**
 * Bounded source-home locator for account erasure. One identity, exclusive
 * prefix, no Book history. Callers own the subsequent revoke/delete work.
 */
export async function pageRevisionDisclosureErasure(
  client: AccessClient,
  locator: RevisionDisclosureErasureLocator,
  context: RevisionDisclosureErasureContext,
): Promise<RevisionDisclosureErasurePage> {
  const route = routeOf(locator.id);
  const after = context.afterDisclosureId ?? null;
  if (route === null || (after !== null && (routeOf(after) !== route || !isRevisionDisclosureUuid(after))))
    return { items: [], next: null };
  const limit = boundLimit(context.limit);
  const rows =
    locator.kind === 'post'
      ? await pagePost.run(client, {
          route,
          post_id: locator.id,
          after_disclosure_id: after,
          limit: limit + 1,
        })
      : await pageThread.run(client, {
          route,
          thread_id: locator.id,
          after_disclosure_id: after,
          limit: limit + 1,
        });
  return pageOf((rows ?? []).map(item), limit);
}

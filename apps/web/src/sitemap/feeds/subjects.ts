import type { Kernel } from '@rezics/client';
import { kernelClient } from '../../kernel/client.ts';
import type { SitemapFeed } from '../feeds.ts';
import { canonicalProjectionUnavailable, type CanonicalSitemapItem, type CanonicalSitemapPage } from '../canonical.ts';

type SubjectPage = Kernel['~Routes']['v1']['subject-pages']['get']['response'][200];

/**
 * The closed owner constructor supplies complete eligible page families, using the ordinary subject reader and
 * bounded reciprocal/current-target Account facts. This is the existing Web family interface, not proposed native
 * fields. Views and account destinations require their owner's current eligibility decision.
 */
export type SubjectCanonicalProjection = (page: SubjectPage) => CanonicalSitemapPage | Promise<CanonicalSitemapPage>;

const unavailable: SubjectCanonicalProjection = () =>
  canonicalProjectionUnavailable(
    'subjects',
    'native publication/disclosure and the closed canonical family constructor with current Account targets',
  );

/** Replace the unavailable adapter only when the actual owner constructor is delivered. No per-row hydration. */
export function createSubjectFeed(
  project: SubjectCanonicalProjection = unavailable,
): SitemapFeed<CanonicalSitemapItem> {
  return {
    type: 'subjects',
    key: (item) => item.key,
    async read(cursor) {
      const result = await kernelClient()['subject-pages'].get({
        query: { ...(cursor === null ? {} : { cursor }), limit: 1_000 },
      });
      if (result.status !== 200 || !result.data)
        throw Object.assign(new Error(`Sitemap feed subjects returned ${result.status}`), { status: result.status });
      const page = await project(result.data);
      if (page.next !== result.data.next) throw new Error('Subject canonical projection changed the native cursor');
      const sourceIds = new Set(result.data.subjectPages.map(({ id }) => id));
      if (page.items.some(({ id }) => !sourceIds.has(id)))
        throw new Error('Subject canonical projection changed the native source identity');
      return page;
    },
    family: (item) => item.family,
  };
}

export const feed = createSubjectFeed();

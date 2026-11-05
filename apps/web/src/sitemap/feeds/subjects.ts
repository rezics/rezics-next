import { kernelClient } from '../../kernel/client.ts';
import type { SitemapFeed } from '../feeds.ts';
import type { CanonicalSitemapItem, CanonicalSitemapPage } from '../canonical.ts';
import { subjectCanonicalPage, type SubjectSitemapPage } from '../subject-canonical.ts';

/**
 * Project the delivered native target/views through the reader's canonical URL helpers. Views and Account
 * destinations require their owner's current facts, never per-row hydration or labels alone.
 */
export type SubjectCanonicalProjection = (
  page: SubjectSitemapPage,
) => CanonicalSitemapPage | Promise<CanonicalSitemapPage>;

export function createSubjectFeed(
  project: SubjectCanonicalProjection = subjectCanonicalPage,
): SitemapFeed<CanonicalSitemapItem> {
  return {
    type: 'subjects',
    key: (item) => item.key,
    async read(cursor) {
      const result = await kernelClient()['subject-pages'].get({
        query: { ...(cursor === null ? {} : { cursor }), limit: 1_000 },
        fetch: { cache: 'no-store' },
      });
      if (result.status !== 200 || !result.data)
        throw Object.assign(new Error(`Sitemap feed subjects returned ${result.status}`), { status: result.status });
      const page = await project(result.data);
      if (page.next !== result.data.next) throw new Error('Subject canonical projection changed the native cursor');
      const sourceIds = result.data.subjectPages.map(({ id }) => id);
      const projectedIds = page.items
        .filter((item, index) => index === 0 || item.id !== page.items[index - 1]!.id)
        .map(({ id }) => id);
      if (projectedIds.length !== sourceIds.length || projectedIds.some((id, index) => id !== sourceIds[index]))
        throw new Error('Subject canonical projection changed the native source identity');
      return page;
    },
    family: (item) => item.family,
  };
}

export const feed = createSubjectFeed();

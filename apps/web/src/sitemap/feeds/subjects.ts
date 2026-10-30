import type { Kernel } from '@rezics/client';
import { kernelClient } from '../../kernel/client.ts';
import { subjectDisplayLabel } from '../../features/pages/subject.tsx';
import { subjectHref } from '../../subject/subject-href.ts';
import { sitemapLocales, type SitemapFeed } from '../feeds.ts';

type SubjectPageItem = Kernel['~Routes']['v1']['subject-pages']['get']['response'][200]['subjectPages'][number];

function family(item: SubjectPageItem) {
  const labels = Object.fromEntries(item.labels.map(({ language, value }) => [language, value]));
  const paths = Object.fromEntries(
    sitemapLocales.map((locale) => {
      // The native projection supplies labels only; original language and canonical identity remain owner inputs.
      const label = subjectDisplayLabel(labels, locale);
      return [locale, subjectHref({ id: item.id, label }, locale).href];
    }),
  ) as Record<(typeof sitemapLocales)[number], string>;
  return {
    paths,
    ...(typeof item.lastModified === 'string' ? { lastmod: item.lastModified } : {}),
  };
}

export const feed: SitemapFeed<SubjectPageItem> = {
  type: 'subjects',
  key: ({ id }) => `${id.slice(24, 28)}${id}`,
  async read(cursor) {
    const result = await kernelClient()['subject-pages'].get({
      query: { ...(cursor === null ? {} : { cursor }), limit: 1_000 },
    });
    if (result.status !== 200 || !result.data)
      throw Object.assign(new Error(`Sitemap feed subjects returned ${result.status}`), { status: result.status });
    return { items: result.data.subjectPages, next: result.data.next };
  },
  family,
};

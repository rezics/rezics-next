import { pageHead } from '../shell/head';
import type { SpacePageData } from './space';

export function communityPageHead(page: SpacePageData | undefined, origin: string, locale: string, path: string) {
  if (!page) return pageHead({ robots: 'noindex, follow' }, { origin, locale: locale as never, path });
  const canonical = `${origin}/${locale}${path}`;
  const graph = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        name: page.space.title,
        description: page.space.summary,
        url: canonical,
        inLanguage: locale,
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'REZICS', item: `${origin}/${locale}` },
          ...(page.realm?.visibility === 'public'
            ? [
                {
                  '@type': 'ListItem',
                  position: 2,
                  name: page.realm.title,
                  item: `${origin}/${locale}/realms/${encodeURIComponent(page.realm.id)}`,
                },
                { '@type': 'ListItem', position: 3, name: page.space.title },
              ]
            : [{ '@type': 'ListItem', position: 2, name: page.space.title }]),
        ],
      },
    ],
  };
  return pageHead(
    {
      title: page.space.title,
      description: page.space.summary,
      type: 'website',
      ...(page.realm?.visibility === 'protected' ? { robots: 'noindex, follow' } : {}),
      jsonLd: graph,
    },
    { origin, locale: locale as never, path },
  );
}

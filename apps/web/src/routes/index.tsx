import { createFileRoute } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { homePageQuery } from '../features/pages/home-queries';
import { homeJsonLd } from '../features/pages/jsonld';
import { pageHead } from '../shell/head';
import { Home } from './-home';

export const Route = createFileRoute('/')({
  staticData: { publicCache: true },
  loader: ({ context }) => context.queryClient.fetchQuery({ ...homePageQuery(getLocale()), staleTime: 0 }),
  head: ({ loaderData }) => {
    const locale = getLocale();
    if (!loaderData) return { meta: [{ title: 'REZICS' }] };
    const origin = loaderData.origin;
    return pageHead(
      { description: m.home_meta_description(), jsonLd: homeJsonLd({ origin, locale }) },
      { origin, locale, path: '/' },
    );
  },
  component: Home,
});

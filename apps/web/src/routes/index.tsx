import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useCallback } from 'react';
import { useSession } from '../session/query';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { homePageQuery, readPrivateHomePage, readPublicHomePage } from '../features/pages/home-queries';
import { HomeFeedConsumer } from '../features/pages/home-feed';
import { homeFeedViewer, type FeedInput } from '../features/pages/home-feed-read';
import { homeJsonLd } from '../features/pages/jsonld';
import { pageHead } from '../shell/head';

export const Route = createFileRoute('/')({
  staticData: { publicCache: true },
  loader: ({ context }) => context.queryClient.ensureQueryData(homePageQuery(getLocale())),
  head: ({ loaderData }) => {
    const locale = getLocale();
    if (!loaderData) return { meta: [{ title: 'REZICS' }] };
    const origin = loaderData.origin;
    return pageHead({ description: m.home_meta_description(), jsonLd: homeJsonLd({ origin, locale }) }, { origin, locale, path: '/' });
  },
  component: Home,
});

export function Home() {
  const locale = getLocale();
  const { data: loaded } = useSuspenseQuery(homePageQuery(locale));
  const viewer = homeFeedViewer(useSession());
  const subject = viewer?.subject;
  const read = useCallback((input: FeedInput) => subject
    ? readPrivateHomePage({ data: { locale, viewer: subject, ...input } })
    : readPublicHomePage({ data: { locale, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) } }), [locale, subject]);
  return <HomeFeedConsumer key={`${locale}:${viewer?.scope ?? 'public'}`} initial={loaded.feed} locale={locale} signedIn={viewer !== null} read={read} />;
}

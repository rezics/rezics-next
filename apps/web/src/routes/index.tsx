import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useCallback } from 'react';
import { useSession } from '../session/query';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import {
  homePageQuery,
  readPrivateHomePage,
  readPublicHomePage,
  readHomeKinds,
  readHomeSpaceChoice,
} from '../features/pages/home-queries';
import { HomeFeedConsumer } from '../features/pages/home-feed';
import type { HomeSpaceRequest } from '../features/pages/home-feed-spaces';
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
    return pageHead(
      { description: m.home_meta_description(), jsonLd: homeJsonLd({ origin, locale }) },
      { origin, locale, path: '/' },
    );
  },
  component: Home,
});

export function Home() {
  const locale = getLocale();
  const { data: loaded } = useSuspenseQuery(homePageQuery(locale));
  const viewer = homeFeedViewer(useSession());
  const subject = viewer?.subject;
  const read = useCallback(
    (input: FeedInput, signal: AbortSignal) =>
      subject
        ? readPrivateHomePage({ data: { locale, viewer: subject, ...input }, signal })
        : readPublicHomePage({ data: { locale, ...input }, signal }),
    [locale, subject],
  );
  const readKinds = useCallback(
    (cursor: string | undefined, signal: AbortSignal) =>
      readHomeKinds({ data: { locale, ...(cursor === undefined ? {} : { cursor }) }, signal }),
    [locale],
  );
  const readSpace = useCallback(
    (input: HomeSpaceRequest, signal: AbortSignal) =>
      readHomeSpaceChoice({
        data: { locale, ...(subject ? { viewer: subject } : {}), ...input },
        signal,
      }),
    [locale, subject],
  );
  return (
    <HomeFeedConsumer
      key={`${locale}:${viewer?.scope ?? 'public'}`}
      initial={loaded.feed}
      locale={locale}
      signedIn={viewer !== null}
      read={read}
      readKinds={readKinds}
      readSpace={readSpace}
      origin={loaded.origin}
    />
  );
}

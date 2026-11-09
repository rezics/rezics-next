import { HomeCatalogue, homeCatalogueObservation } from '../features/pages/home-catalogue';
import { useSuspenseQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useSession } from '../session/query';
import { getLocale } from '../paraglide/runtime.js';
import {
  homePageQuery,
  readPrivateHomePage,
  readPublicHomePage,
  readHomeKinds,
  readHomeSpaceChoice,
  readHomeQuestions,
} from '../features/pages/home-queries';
import { HomeFeedConsumer } from '../features/pages/home-feed';
import type { HomeSpaceRequest } from '../features/pages/home-feed-spaces';
import { homeFeedViewer, type FeedInput } from '../features/pages/home-feed-read';

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
  const readQuestions = useCallback(
    async (cursor: string | undefined, signal: AbortSignal) => {
      const result = await readHomeQuestions({
        data: { locale, ...(subject ? { viewer: subject } : {}), ...(cursor === undefined ? {} : { cursor }) },
        signal,
      });
      return result.status === 'ready' && !('page' in result)
        ? { status: 'unavailable' as const, code: 'invalid_question_response' }
        : result;
    },
    [locale, subject],
  );
  const readQuestion = useCallback(
    async (questionId: string, signal: AbortSignal) => {
      const result = await readHomeQuestions({
        data: { locale, ...(subject ? { viewer: subject } : {}), questionId },
        signal,
      });
      return result.status === 'ready' && !('question' in result)
        ? { status: 'unavailable' as const, code: 'invalid_question_response' }
        : result;
    },
    [locale, subject],
  );
  return (
    <HomeFeedConsumer
      key={`${locale}:${viewer?.scope ?? 'public'}`}
      initial={loaded.feed}
      catalogue={<HomeCatalogue result={loaded.catalogue} locale={locale} />}
      locale={locale}
      signedIn={viewer !== null}
      read={read}
      readKinds={readKinds}
      readSpace={readSpace}
      readQuestions={readQuestions}
      readQuestion={readQuestion}
      origin={loaded.origin}
      reader={viewer?.subject ?? null}
      credentialEpoch={viewer?.scope ?? null}
      catalogueObservation={homeCatalogueObservation(loaded.catalogue)}
      verification={loaded.verification}
    />
  );
}

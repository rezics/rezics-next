import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { personalRead } from '../kernel/query';
import { exposureQuery, useSession } from '../session/query';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { homePageQuery, readHomeContinue } from '../features/pages/home-queries';
import { homeJsonLd } from '../features/pages/jsonld';
import { RoutePage, routePageJsonLd } from '../features/pages/route';
import { ContinueSection, useContinuePreparation } from '../library/continue';
import { homeContinueQuery } from '../library/continue-read';
import { operationGroups } from '../kernel/exposure';
import { pageHead } from '../shell/head';
import { PageHeading } from '../shell/page-heading';

/** The public page query calls loadRoutePage() once on the server. */
export const Route = createFileRoute('/')({
  staticData: { publicCache: true },
  loader: ({ context }) => context.queryClient.ensureQueryData(homePageQuery(getLocale())),
  head: ({ loaderData }) => {
    const locale = getLocale();
    if (!loaderData) return { meta: [{ title: 'REZICS' }] };
    const origin = loaderData.origin;
    const pageJsonLd = loaderData.kind === 'page' ? routePageJsonLd(loaderData.page, locale, origin) : undefined;
    const jsonLd = pageJsonLd ? JSON.parse(pageJsonLd) : homeJsonLd({ origin, locale });
    return pageHead({ description: m.home_meta_description(), jsonLd }, { origin, locale, path: '/' });
  },
  component: Home,
});

function Home() {
  const { data: loaded } = useSuspenseQuery(homePageQuery(getLocale()));
  const { state } = useSession();
  const { data: viewerGroups } = useQuery({
    ...exposureQuery,
    enabled: personalRead.enabled && state === 'signed-in',
  });
  const hasContinueList = viewerGroups?.includes(operationGroups['library_continue.list']) ?? false;
  const exposureReady = viewerGroups !== undefined;
  const resume = useQuery({
    ...homeContinueQuery(getLocale(), () => readHomeContinue({ data: getLocale() })),
    enabled: personalRead.enabled && state === 'signed-in' && hasContinueList,
  });
  useContinuePreparation(resume.data, resume.refetch, getLocale());
  const continueState = resume.isError || (exposureReady && !hasContinueList)
    ? { state: 'unavailable' as const }
    : resume.data ?? { state: 'unknown' as const };
  const nonce = useRouter().options.ssr?.nonce;
  if (loaded.kind === 'missing') return <PageHeading>{m.home_heading()}</PageHeading>;
  return (
    <RoutePage
      page={loaded.page}
      locale={getLocale()}
      heading={m.home_heading()}
      {...(nonce !== undefined ? { nonce } : {})}
      renderJsonLd={false}
      {...(state === 'signed-in'
        ? {
            personal: (
              <ContinueSection
                state={continueState}
                locale={getLocale()}
                {...(hasContinueList ? { onRetry: () => void resume.refetch() } : {})}
                busy={resume.isFetching}
              />
            ),
          }
        : {})}
      messages={{
        unknown: m.subject_value_unknown(),
        none: m.subject_value_none(),
        unlabelled: m.subject_value_unlabelled(),
        sources: m.subject_sources(),
        aliases: m.subject_aliases(),
        search: m.search_submit(),
      }}
    />
  );
}

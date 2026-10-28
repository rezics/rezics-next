import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { personalRead } from '../kernel/query';
import { useSession } from '../session/query';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { kernelClient } from '../kernel/client';
import { homePageQuery } from '../features/pages/home-queries';
import { homeJsonLd } from '../features/pages/jsonld';
import { RoutePage, routePageJsonLd } from '../features/pages/route';
import { ContinueSection } from '../library/continue';
import { homeContinueQuery, loadContinue } from '../library/continue-read';
import type { SessionEnv } from '../session/client';
import { pageHead } from '../shell/head';
import { validatePublicOrigin } from '../shell/origin';
import { PageHeading } from '../shell/page-heading';

const readHomeContinue = createServerFn({ method: 'GET' }).handler(async () => {
  setResponseHeader('Cache-Control', 'private, no-store');
  return loadContinue(kernelClient(), getRequest(), env as Partial<SessionEnv>);
});

/** The public page query calls loadRoutePage() once on the server. */
export const Route = createFileRoute('/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(homePageQuery(getLocale())),
  head: ({ loaderData }) => {
    const locale = getLocale();
    const origin =
      typeof window === 'undefined'
        ? validatePublicOrigin((env as typeof env & { PUBLIC_ORIGIN?: string }).PUBLIC_ORIGIN)
        : new URL(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')!.href).origin;
    const pageJsonLd = loaderData?.kind === 'page' ? routePageJsonLd(loaderData.page, locale, origin) : undefined;
    const jsonLd = pageJsonLd ? JSON.parse(pageJsonLd) : homeJsonLd({ origin, locale });
    const context = typeof window === 'undefined' ? { origin, locale, path: '/' } : undefined;
    return pageHead({ description: m.home_meta_description(), jsonLd }, context);
  },
  component: Home,
});

function Home() {
  const { data: loaded } = useSuspenseQuery(homePageQuery(getLocale()));
  const { state } = useSession();
  const { data: resume = [], isPending } = useQuery({
    ...homeContinueQuery(getLocale(), () => readHomeContinue()),
    enabled: personalRead.enabled && state === 'signed-in',
  });
  const nonce = useRouter().options.ssr?.nonce;
  if (loaded.kind === 'missing') return <PageHeading>{m.home_heading()}</PageHeading>;
  return (
    <RoutePage
      page={loaded.page}
      locale={getLocale()}
      heading={m.home_heading()}
      {...(nonce !== undefined ? { nonce } : {})}
      renderJsonLd={false}
      {...(state === 'signed-in' && (isPending || resume.length > 0)
        ? { personal: <ContinueSection entries={resume} locale={getLocale()} /> }
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

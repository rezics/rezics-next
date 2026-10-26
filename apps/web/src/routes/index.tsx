import { createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { kernelClient } from '../kernel/client';
import { loadRoutePage, RoutePage, routePageJsonLd } from '../features/pages/route';
import { ContinueRow } from '../library/continue';
import { loadHome } from '../library/continue-read';
import type { SessionEnv } from '../session/client';
import { PageHeading } from '../shell/page-heading';

const readHome = createServerFn({ method: 'GET' }).handler(async () => {
  const client = kernelClient();
  return loadHome(client, getRequest(), env as Partial<SessionEnv>, () => loadRoutePage(client, '/'));
});

export const Route = createFileRoute('/')({
  loader: () => readHome(),
  head: ({ loaderData }) => {
    const jsonLd = loaderData?.page.kind === 'page' ? routePageJsonLd(loaderData.page.page, getLocale()) : undefined;
    return {
      meta: [{ title: m.home_heading() }],
      ...(jsonLd ? { scripts: [{ type: 'application/ld+json', children: jsonLd }] } : {}),
    };
  },
  component: Home,
});

function Home() {
  const { page: loaded, continue: resume } = Route.useLoaderData();
  const nonce = useRouter().options.ssr?.nonce;
  if (loaded.kind === 'missing') return <PageHeading>{m.home_heading()}</PageHeading>;
  return (
    <RoutePage
      page={loaded.page}
      locale={getLocale()}
      heading={m.home_heading()}
      {...(nonce !== undefined ? { nonce } : {})}
      renderJsonLd={false}
      {...(resume.length > 0 ? { personal: <ContinueRow entries={resume} locale={getLocale()} /> } : {})}
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

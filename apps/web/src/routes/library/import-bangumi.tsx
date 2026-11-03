import { createFileRoute } from '@tanstack/react-router';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import { prepareExposure } from '../../kernel/exposure';
import { PersonalBangumiImportPage } from '../../library/personal-bangumi-import';
import { nativeBangumiImport } from '../../library/personal-bangumi-import/native';
import { m } from '../../paraglide/messages.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { BangumiUnavailable } from '../../library/personal-bangumi-import/states';

export const Route = createFileRoute('/library/import-bangumi')({
  beforeLoad: async (context) => {
    await requireSignedIn(context);
    await prepareExposure(context.context.queryClient);
  },
  loader: () => {
    setResponseHeader('cache-control', 'private, no-store');
    void getRequest();
    const origin = Boolean((env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN);
    return { available: origin && !!nativeBangumiImport(kernelClient()) };
  },
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.library_bangumi_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: BangumiImportRoute,
});

function BangumiImportRoute() {
  const { available } = Route.useLoaderData();
  if (!available) return <BangumiUnavailable />;
  return <PersonalBangumiImportPage />;
}

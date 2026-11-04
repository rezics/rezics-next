import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { hasKernelOrigin, kernelClient, preparePrivatePage } from '../../kernel/client';
import { prepareExposure } from '../../kernel/exposure';
import { PersonalBangumiImportPage } from '../../library/personal-bangumi-import';
import { nativeBangumiImport } from '../../library/personal-bangumi-import/native';
import { m } from '../../paraglide/messages.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { BangumiUnavailable } from '../../library/personal-bangumi-import/states';

const loadAvailability = createServerFn({ method: 'GET' }).handler(() => {
  preparePrivatePage();
  return { available: hasKernelOrigin() && !!nativeBangumiImport(kernelClient()) };
});

export const Route = createFileRoute('/library/import-bangumi')({
  beforeLoad: async (context) => {
    await requireSignedIn(context);
    await prepareExposure(context.context.queryClient);
  },
  loader: () => loadAvailability(),
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

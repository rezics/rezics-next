import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { hasKernelOrigin, kernelClient, preparePrivatePage } from '../../kernel/client';
import { prepareExposure } from '../../kernel/exposure';
import { PersonalAniListImportPage } from '../../library/personal-anilist-import';
import { nativeAniListImport } from '../../library/personal-anilist-import/native';
import { AniListUnavailable } from '../../library/personal-anilist-import/states';
import { m } from '../../paraglide/messages.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

const loadAvailability = createServerFn({ method: 'GET' }).handler(() => {
  preparePrivatePage();
  return { available: hasKernelOrigin() && !!nativeAniListImport(kernelClient()) };
});

export const Route = createFileRoute('/library/import-anilist')({
  beforeLoad: async (context) => {
    await requireSignedIn(context);
    await prepareExposure(context.context.queryClient);
  },
  loader: () => loadAvailability(),
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.library_anilist_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: AniListImportRoute,
});

function AniListImportRoute() {
  const { available } = Route.useLoaderData();
  if (!available) return <AniListUnavailable />;
  return <PersonalAniListImportPage />;
}

import { createFileRoute, useLocation } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { hasKernelOrigin, kernelClient, preparePrivatePage } from '../../kernel/client';
import { prepareExposure } from '../../kernel/exposure';
import { PersonalVndbImportPage } from '../../library/personal-list-import';
import { nativeVndbImport } from '../../library/personal-list-import/native';
import { VndbUnavailable } from '../../library/personal-list-import/states';
import { m } from '../../paraglide/messages.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { importLibraryAnchor } from '../../library/showcase-import-return/navigation';
import { vndbReviewSearch } from '../../library/personal-list-import/address';

const loadAvailability = createServerFn({ method: 'GET' }).handler(() => {
  preparePrivatePage();
  return { available: hasKernelOrigin() && !!nativeVndbImport(kernelClient()) };
});

export const Route = createFileRoute('/library/import-vndb')({
  validateSearch: vndbReviewSearch,
  beforeLoad: async (context) => {
    await requireSignedIn(context);
    await prepareExposure(context.context.queryClient);
  },
  loader: () => loadAvailability(),
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.library_vndb_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: VndbImportRoute,
});

function VndbImportRoute() {
  const { available } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const libraryReturn = useLocation({ select: (location) => location.hash.replace(/^#/, '') === importLibraryAnchor });
  if (!available) return <VndbUnavailable />;
  return (
    <PersonalVndbImportPage
      libraryReturn={libraryReturn}
      {...(search.uploadId ? { address: { uploadId: search.uploadId, offset: search.offset ?? 0 } } : {})}
      onAddressChange={(address) => {
        if (search.uploadId !== address.uploadId || search.offset !== address.offset)
          void navigate({ search: address, replace: true, ignoreBlocker: true, resetScroll: false });
      }}
    />
  );
}

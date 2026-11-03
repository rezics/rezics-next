import { createFileRoute } from '@tanstack/react-router';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import { prepareExposure } from '../../kernel/exposure';
import { PersonalVndbImportPage } from '../../library/personal-list-import';
import { nativeVndbImport } from '../../library/personal-list-import/native';
import { VndbUnavailable } from '../../library/personal-list-import/states';
import { m } from '../../paraglide/messages.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/library/import-vndb')({
  beforeLoad: async (context) => {
    await requireSignedIn(context);
    await prepareExposure(context.context.queryClient);
  },
  loader: () => {
    setResponseHeader('cache-control', 'private, no-store');
    void getRequest();
    const origin = Boolean((env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN);
    return { available: origin && !!nativeVndbImport(kernelClient()) };
  },
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) => pageHead({ title: m.library_vndb_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: VndbImportRoute,
});

function VndbImportRoute() {
  const { available } = Route.useLoaderData();
  if (!available) return <VndbUnavailable />;
  return <PersonalVndbImportPage />;
}

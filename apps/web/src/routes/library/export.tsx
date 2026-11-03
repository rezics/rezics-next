import { createFileRoute } from '@tanstack/react-router';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import { prepareExposure } from '../../kernel/exposure';
import { PrivateLibraryExportPage } from '../../library/private-export';
import { nativeLibraryExport } from '../../library/private-export/native';
import { ExportUnavailable } from '../../library/private-export/states';
import { m } from '../../paraglide/messages.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/library/export')({
  beforeLoad: async (context) => {
    await requireSignedIn(context);
    await prepareExposure(context.context.queryClient);
  },
  loader: () => {
    setResponseHeader('cache-control', 'private, no-store');
    void getRequest();
    const origin = Boolean((env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN);
    return { available: origin && !!nativeLibraryExport(kernelClient()) };
  },
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.library_export_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: LibraryExportRoute,
});

function LibraryExportRoute() {
  const { available } = Route.useLoaderData();
  if (!available) return <ExportUnavailable />;
  return <PrivateLibraryExportPage />;
}

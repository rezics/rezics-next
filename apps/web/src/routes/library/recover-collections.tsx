import { createFileRoute } from '@tanstack/react-router';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import { prepareExposure } from '../../kernel/exposure';
import { nativeArchiveCollectionRecovery } from '../../library/archive-collection-recovery/native';
import { PrivateArchiveCollectionRecoveryPage } from '../../library/archive-collection-recovery';
import { m } from '../../paraglide/messages.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/library/recover-collections')({
  beforeLoad: async (context) => {
    await requireSignedIn(context);
    await prepareExposure(context.context.queryClient);
  },
  loader: () => {
    setResponseHeader('cache-control', 'private, no-store');
    void getRequest();
    const origin = Boolean((env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN);
    return { available: origin && Boolean(nativeArchiveCollectionRecovery(kernelClient())) };
  },
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) =>
    pageHead(
      { title: m.library_archive_recovery_title(), robots: 'noindex, nofollow' },
      pageHeadContext(match.pathname),
    ),
  component: RecoveryRoute,
});

function RecoveryRoute() {
  const { available } = Route.useLoaderData();
  if (!available) {
    return (
      <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6">
        <h1 className="text-2xl font-semibold">{m.library_archive_recovery_title()}</h1>
        <p role="status">{m.library_archive_recovery_unavailable()}</p>
      </main>
    );
  }
  return <PrivateArchiveCollectionRecoveryPage />;
}

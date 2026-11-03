import { createFileRoute } from '@tanstack/react-router';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import { prepareExposure } from '../../kernel/exposure';
import { PersonalMalImportPage } from '../../library/personal-mal-import';
import { nativeMalImport } from '../../library/personal-mal-import/native';
import { m } from '../../paraglide/messages.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/library/import-mal')({
  beforeLoad: async (context) => {
    await requireSignedIn(context);
    await prepareExposure(context.context.queryClient);
  },
  loader: () => {
    setResponseHeader('cache-control', 'private, no-store');
    void getRequest();
    const origin = Boolean((env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN);
    return { available: origin && !!nativeMalImport(kernelClient()) };
  },
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.library_mal_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: MalImportRoute,
});

function MalImportRoute() {
  const { available } = Route.useLoaderData();
  if (!available) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-6">
        <h1 className="text-4xl font-semibold tracking-tight">{m.library_mal_title()}</h1>
        <p role="status">{m.library_mal_unavailable()}</p>
      </main>
    );
  }
  return <PersonalMalImportPage />;
}

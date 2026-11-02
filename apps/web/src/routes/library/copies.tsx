import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import { postCopyForm } from '../../library/copies-form-action';
import type { SessionEnv } from '../../session/client';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { createFileRoute } from '@tanstack/react-router';
import { CopiesCurrent } from '../../library/copies-current';
import { getLocale } from '../../paraglide/runtime.js';
import { readCopiesCurrent } from '../../library/copies-actions';
import { copiesQuery } from '../../library/copies-query';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/library/copies')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const result = await postCopyForm(kernelClient(), request, env as Partial<SessionEnv>);
        const url = new URL(request.url);
        if (!result.ok) url.searchParams.set('copyFailure', result.reason);
        else url.searchParams.delete('copyFailure');
        return new Response(null, {
          status: 303,
          headers: { location: url.pathname + url.search, 'cache-control': 'private, no-store' },
        });
      },
    },
  },
  beforeLoad: requireSignedIn,
  validateSearch: (search: Record<string, unknown>) => {
    return {
      ...(typeof search.copyFailure === 'string' ? { copyFailure: search.copyFailure } : {}),
      ...copiesQuery(search),
    };
  },
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => readCopiesCurrent({ data: deps }),
  staleTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.library_copy_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: CopiesRoute,
});

function CopiesRoute() {
  const search = Route.useSearch();
  return (
    <CopiesCurrent initial={Route.useLoaderData()} search={search} locale={getLocale()} failure={search.copyFailure} />
  );
}

import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import { postCopyForm } from '../../library/copies-form-action';
import type { SessionEnv } from '../../session/client';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { createFileRoute } from '@tanstack/react-router';
import { CopiesPage } from '../../library/copies-page';
import { readCopiesPage } from '../../library/copies-actions';
import { copiesSubjectId } from '../../library/copies-query';
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
    const subjectId = copiesSubjectId(search.subjectId);
    return {
      ...(typeof search.copyFailure === 'string' ? { copyFailure: search.copyFailure } : {}),
      ...(subjectId ? { subjectId } : {}),
      ...(typeof search.cursor === 'string' && search.cursor.length > 0 && search.cursor.length <= 2048
        ? { cursor: search.cursor }
        : {}),
    };
  },
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => readCopiesPage({ data: deps }),
  head: ({ match }) =>
    pageHead({ title: m.library_copy_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: CopiesRoute,
});

function CopiesRoute() {
  return <CopiesPage page={Route.useLoaderData()} failure={Route.useSearch().copyFailure} />;
}

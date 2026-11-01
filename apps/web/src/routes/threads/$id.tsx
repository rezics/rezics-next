import { createFileRoute, redirect } from '@tanstack/react-router';
import * as v from 'valibot';
import { getLocale } from '../../paraglide/runtime.js';
import { threadSlugQuery } from '../../threads/thread-queries';
import { rememberThreadSlug, threadLocation } from '../../threads/thread-href';
import { runThreadPageQuery, ThreadPageCaller } from '../../threads/thread-page-caller';

function threadSearch(search: Record<string, unknown>): { cursor?: string } {
  const cursor = v.parse(v.fallback(v.optional(v.string()), undefined), search.cursor);
  return typeof cursor === 'string' ? { cursor } : {};
}

/** The id without a slug redirects to the canonical thread URL and keeps the cursor. */
export const Route = createFileRoute('/threads/$id')({
  validateSearch: threadSearch,
  loaderDeps: ({ search }) => ({ cursor: threadSearch(search).cursor }),
  loader: async ({ params, deps, context }) => {
    const query = threadSlugQuery(params.id, context.credentialMode);
    const caller = ThreadPageCaller.capture(
      context.queryClient,
      {
        id: params.id,
        ...(deps.cursor === undefined ? {} : { cursor: deps.cursor }),
        locale: getLocale(),
        credentialMode: context.credentialMode,
      },
      undefined,
      query.queryKey,
    );
    const head = await runThreadPageQuery(context.queryClient, caller, query, (guarded) =>
      context.queryClient.ensureQueryData(guarded),
    );
    caller.assertReadCurrent();
    rememberThreadSlug(head.id, head.title);
    caller.assertReadCurrent();
    const href = threadLocation(getLocale(), head, deps.cursor);
    caller.assertReadCurrent();
    caller.retireFromRouteChange();
    throw redirect({ href, statusCode: 301 });
  },
  component: () => null,
});

import { createFileRoute, redirect } from '@tanstack/react-router';
import { getLocale } from '../../paraglide/runtime.js';
import { threadSlugQuery } from '../../threads/thread-queries';
import { rememberThreadSlug, threadLocation, threadSearch } from '../../threads/thread-href';
import { runThreadPageQuery, ThreadPageCaller } from '../../threads/thread-page-caller';

/** The id without a slug redirects to the canonical thread URL and keeps the cursor and linked post. */
export const Route = createFileRoute('/threads/$id')({
  validateSearch: threadSearch,
  loaderDeps: ({ search }) => threadSearch(search),
  loader: async ({ params, deps, context }) => {
    const query = threadSlugQuery(params.id, context.credentialMode);
    const caller = ThreadPageCaller.capture(
      context.queryClient,
      {
        id: params.id,
        ...(deps.cursor === undefined ? {} : { cursor: deps.cursor }),
        ...(deps.post === undefined ? {} : { post: deps.post }),
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
    const href = threadLocation(
      getLocale(),
      head,
      deps.cursor,
      deps.post,
      {
        ...(deps.historyReturn ? { token: deps.historyReturn } : {}),
        ...(deps.historyRevision ? { revisionId: deps.historyRevision } : {}),
      },
      deps.boardReturn,
    );
    caller.assertReadCurrent();
    caller.retireFromRouteChange();
    throw redirect({ href, statusCode: 301 });
  },
  component: () => null,
});

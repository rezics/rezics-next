import { CommunityRouteNotFound, readCommunityRoute } from '../../community/protected-route';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { getLocale } from '../../paraglide/runtime.js';
import { threadSlugQuery } from '../../threads/thread-queries';
import { rememberThreadSlug, threadLocation, threadSearch } from '../../threads/thread-href';
import { runThreadPageQuery, ThreadPageCaller } from '../../threads/thread-page-caller';

/** The id without a slug redirects to the canonical thread URL and keeps the cursor and linked post. */
export const Route = createFileRoute('/threads/$id')({
  validateSearch: threadSearch,
  loaderDeps: ({ search }) => threadSearch(search),
  loader: ({ params, deps, context }) =>
    readCommunityRoute(context.queryClient, context.credentialMode, async (credentialMode, reader) => {
      const query = threadSlugQuery(params.id, credentialMode, reader);
      const caller = ThreadPageCaller.capture(
        context.queryClient,
        {
          id: params.id,
          ...(deps.cursor === undefined ? {} : { cursor: deps.cursor }),
          ...(deps.post === undefined ? {} : { post: deps.post }),
          locale: getLocale(),
          credentialMode: credentialMode,
        },
        undefined,
        query.queryKey,
      );
      const head = await runThreadPageQuery(context.queryClient, caller, query, (guarded) =>
        context.queryClient.ensureQueryData(guarded),
      );
      caller.assertReadCurrent();
      if (credentialMode === 'anonymous') rememberThreadSlug(head.id, head.title);
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
      throw redirect(
        credentialMode === 'anonymous'
          ? { href, statusCode: 301 }
          : { href, statusCode: 302, headers: { 'Cache-Control': 'private, no-store' } },
      );
    }),
  notFoundComponent: CommunityRouteNotFound,
  component: () => null,
});

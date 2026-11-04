import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useRouter, useRouterState } from '@tanstack/react-router';
import { m } from '../../paraglide/messages.js';
import { historicalReaderSource } from '../../threads/historical-reader-provenance';
import { parseHistoryReturnToken, resolveHistoryReturnTarget } from '../../threads/revision-return/history-return';
import { readExactRevision } from '../../threads/exact-revision-read';
import { ExactRevisionView } from '../../threads/exact-revision-view';
import { ExactRevisionCaller, readExactRevisionVisit } from '../../threads/exact-revision-caller';
import { getLocale } from '../../paraglide/runtime.js';

export const Route = createFileRoute('/posts/$id/revisions/$revisionId')({
  staticData: { sessionReread: true },
  validateSearch: (search: Record<string, unknown>) => {
    const historyReturn = parseHistoryReturnToken(search.historyReturn);
    return historyReturn ? { historyReturn } : {};
  },
  // Immutable bytes still need fresh current disclosure on every entry and retry.
  staleTime: 0,
  gcTime: 0,
  shouldReload: true,
  pendingMs: 0,
  loader: ({ params, context }) => {
    const identity = { postId: params.id, revisionId: params.revisionId };
    const locale = getLocale();
    const credentialMode = context.credentialMode;
    return readExactRevisionVisit(context.queryClient, identity, locale, credentialMode, (binding) =>
      readExactRevision({ data: { ...identity, locale, credentialMode, binding } }),
    );
  },
  head: () => ({ meta: [{ title: m.exact_revision_heading() }, { name: 'robots', content: 'noindex, follow' }] }),
  pendingComponent: ExactRevisionPending,
  component: ExactRevisionPage,
});

function ExactRevisionPending() {
  const params = Route.useParams();
  const { historyReturn } = Route.useSearch();
  const { credentialMode } = Route.useRouteContext();
  const locale = getLocale();
  const source = historicalReaderSource(useQueryClient());
  const returnTarget = resolveHistoryReturnTarget(
    historyReturn,
    { postId: params.id, revisionId: params.revisionId },
    locale,
    credentialMode,
    source,
  );
  return (
    <ExactRevisionView
      identity={{ postId: params.id, revisionId: params.revisionId }}
      page={{ state: 'loading' }}
      {...(returnTarget ? { historyReturn: returnTarget } : {})}
    />
  );
}

function ExactRevisionPage() {
  const params = Route.useParams();
  const visit = Route.useLoaderData();
  const router = useRouter();
  const { credentialMode } = Route.useRouteContext();
  const { historyReturn } = Route.useSearch();
  const loading = useRouterState({ select: (state) => state.isLoading });
  const locale = getLocale();
  return (
    <ExactRevisionCaller
      visit={visit}
      identity={{ postId: params.id, revisionId: params.revisionId }}
      locale={locale}
      credentialMode={credentialMode}
      loading={loading}
      onRetry={() => void router.invalidate()}
      {...(historyReturn ? { historyReturnToken: historyReturn } : {})}
    />
  );
}

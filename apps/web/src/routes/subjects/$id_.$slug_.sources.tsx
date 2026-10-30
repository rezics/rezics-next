import { validatePageRealm } from '../../features/pages/view-cursor';
import { subjectRequestReader } from '../../features/pages/subject-queries';
import { subjectReaderPartition, useSubjectReaderRefresh } from '../../features/pages/context-reader';
import { useSession } from '../../session/query';
import { createFileRoute, notFound, redirect, useRouter, useRouterState } from '@tanstack/react-router';
import { loadSubjectSources } from '../../features/catalogue/subject-sources-actions';
import { SubjectSourcesPage } from '../../features/catalogue/subject-sources-page';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { canonicalRedirect, subjectHref } from '../../subject/subject-href';

export const Route = createFileRoute('/subjects/$id_/$slug_/sources')({
  staticData: { publicCache: false },
  staleTime: 0,
  gcTime: 0,
  shouldReload: true,
  validateSearch: (search: Record<string, unknown>) => ({ realm: validatePageRealm(search.realm) }),
  loaderDeps: ({ search }) => ({ realm: search.realm }),
  loader: async ({ params, location, deps }) => {
    const reader = await subjectRequestReader({ data: { realm: deps.realm } });
    const result = await loadSubjectSources({
      data: { id: params.id, locale: getLocale(), realm: deps.realm, reader },
    });
    if (result.kind === 'missing') throw notFound();
    if (result.kind === 'ready') {
      const canonical = subjectHref({ id: result.page.id, label: result.page.title.text }, getLocale());
      if (result.page.id !== params.id || canonical.params.slug !== params.slug)
        throw redirect(canonicalRedirect(result.page.sourcesHref.split('?', 1)[0]!, location.searchStr, location.hash));
    }
    return { result, reader };
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: `${m.subject_sources()}${loaderData?.result.kind === 'ready' ? ` · ${loaderData.result.page.title.text}` : ''}`,
      },
      { name: 'robots', content: 'noindex,follow' },
    ],
  }),
  pendingComponent: () => <SubjectSourcesPage result={{ kind: 'loading' }} locale={getLocale()} />,
  errorComponent: SourcesError,
  component: SourcesRoute,
});

function SourcesRoute() {
  const { result, reader } = Route.useLoaderData();
  const { realm } = Route.useSearch();
  const currentReader = useSubjectReaderRefresh(reader, subjectReaderPartition(realm, reader, useSession()));
  const router = useRouter();
  const busy = useRouterState({ select: (state) => state.isLoading });
  if (!currentReader) return <SubjectSourcesPage result={{ kind: 'loading' }} locale={getLocale()} />;
  return (
    <SubjectSourcesPage
      result={result}
      locale={getLocale()}
      busy={busy}
      onRetry={() => {
        void router.invalidate();
      }}
    />
  );
}

function SourcesError({ reset }: { reset: () => void }) {
  return <SubjectSourcesPage result={{ kind: 'unavailable' }} locale={getLocale()} onRetry={reset} />;
}

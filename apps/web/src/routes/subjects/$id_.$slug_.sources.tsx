import { validatePageRealm } from '../../features/pages/view-cursor';
import { subjectRequestReader } from '../../features/pages/subject-queries';
import { subjectReaderPartition, useSubjectReaderRefresh } from '../../features/pages/context-reader';
import { useSession } from '../../session/query';
import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { loadSubjectSources } from '../../features/catalogue/subject-sources-actions';
import { SubjectSourcesPage } from '../../features/catalogue/subject-sources-page';
import { useSourcesRetry } from '../../features/catalogue/subject-sources-retry';
import type { SourcesResult } from '../../features/catalogue/subject-sources';
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
  pendingComponent: () => <SourcesPresentation result={{ kind: 'loading' }} />,
  errorComponent: SourcesError,
  component: SourcesRoute,
});

function SourcesRoute() {
  const { result, reader } = Route.useLoaderData();
  const { realm } = Route.useSearch();
  const currentReader = useSubjectReaderRefresh(reader, subjectReaderPartition(realm, reader, useSession()));
  return <SourcesPresentation result={currentReader ? result : { kind: 'loading' }} reader={reader} />;
}

function SourcesError({ reset }: { reset: () => void }) {
  return <SourcesPresentation result={{ kind: 'unavailable' }} reset={reset} />;
}

function SourcesPresentation({
  result,
  reader = null,
  reset,
}: {
  result: SourcesResult | { kind: 'loading' };
  reader?: string | null;
  reset?: () => void;
}) {
  const { realm } = Route.useSearch();
  const locale = getLocale();
  const retry = useSourcesRetry({
    realm,
    reader,
    locale,
    loading: result.kind === 'loading',
    ...(reset ? { reset } : {}),
  });
  return <SubjectSourcesPage result={result} locale={locale} {...retry} />;
}

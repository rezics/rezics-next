import { createFileRoute, notFound, redirect, useRouter, useRouterState } from '@tanstack/react-router';
import { loadSubjectSources } from '../../features/catalogue/subject-sources-actions';
import { SubjectSourcesPage } from '../../features/catalogue/subject-sources-page';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { canonicalRedirect, subjectHref } from '../../subject/subject-href';

export const Route = createFileRoute('/subjects/$id_/$slug_/sources')({
  staticData: { publicCache: false },
  loader: async ({ params, location }) => {
    const result = await loadSubjectSources({ data: { id: params.id, locale: getLocale() } });
    if (result.kind === 'missing') throw notFound();
    if (result.kind === 'ready') {
      const canonical = subjectHref({ id: result.page.id, label: result.page.title.text }, getLocale());
      if (result.page.id !== params.id || canonical.params.slug !== params.slug)
        throw redirect(canonicalRedirect(result.page.sourcesHref, location.searchStr, location.hash));
    }
    return result;
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: `${m.subject_sources()}${loaderData?.kind === 'ready' ? ` · ${loaderData.page.title.text}` : ''}` },
      { name: 'robots', content: 'noindex,follow' },
    ],
  }),
  pendingComponent: () => <SubjectSourcesPage result={{ kind: 'loading' }} locale={getLocale()} />,
  errorComponent: SourcesError,
  component: SourcesRoute,
});

function SourcesRoute() {
  const result = Route.useLoaderData();
  const router = useRouter();
  const busy = useRouterState({ select: (state) => state.isLoading });
  return <SubjectSourcesPage result={result} locale={getLocale()} busy={busy} onRetry={() => { void router.invalidate(); }} />;
}

function SourcesError({ reset }: { reset: () => void }) {
  return <SubjectSourcesPage result={{ kind: 'unavailable' }} locale={getLocale()} onRetry={reset} />;
}

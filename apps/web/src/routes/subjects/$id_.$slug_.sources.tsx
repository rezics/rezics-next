import { useEffect, useState } from 'react';
import { csrfHeaders } from '../../threads/composer';
import { validatePageRealm } from '../../features/pages/view-cursor';
import { subjectRequestReader } from '../../features/pages/subject-queries';
import { subjectReaderPartition, useSubjectReaderRefresh } from '../../features/pages/context-reader';
import { useSession } from '../../session/query';
import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { loadSubjectSources, readCurrentSubjectSources } from '../../features/catalogue/subject-sources-actions';
import { SubjectSourcesPage } from '../../features/catalogue/subject-sources-page';
import { useSourcesRetry } from '../../features/catalogue/subject-sources-retry';
import type { SourcesResult } from '../../features/catalogue/subject-sources';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { canonicalRedirect, subjectHref } from '../../subject/subject-href';
import { sourceObservationSelection } from '../../features/catalogue/source-observation/contract';
import type { SourceObservationRequest } from '../../features/catalogue/source-observation/contract';
import { inspectSubjectSourceObservation } from '../../features/catalogue/source-observation/action';
import { subjectVisitReturn } from '../../features/pages/subject-visit-navigation';

const inspectSourceObservation = (request: SourceObservationRequest) =>
  inspectSubjectSourceObservation({ data: request });

export const Route = createFileRoute('/subjects/$id_/$slug_/sources')({
  staticData: { publicCache: false },
  staleTime: 0,
  gcTime: 0,
  shouldReload: true,
  validateSearch: (search: Record<string, unknown>) => {
    const selection = sourceObservationSelection(search);
    return {
      realm: validatePageRealm(search.realm),
      via: subjectVisitReturn(search.via, getLocale()),
      ...(selection ? { provider: selection.source, digest: selection.digest } : {}),
    };
  },
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
    return { result, reader, visit: crypto.randomUUID() };
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
  const { result, reader, visit } = Route.useLoaderData();
  const { realm, via } = Route.useSearch();
  const session = useSession();
  const currentReader = useSubjectReaderRefresh(reader, subjectReaderPartition(realm, reader, session));
  const scope = JSON.stringify([visit, session.state, session.subject, session.csrfToken]);
  const [current, setCurrent] = useState<{ source: SourcesResult; scope: string; result: SourcesResult }>();
  useEffect(() => {
    let live = true;
    setCurrent(undefined);
    if (
      !realm &&
      result.kind === 'ready' &&
      (session.state === 'signed-out' || (session.state === 'signed-in' && session.subject))
    ) {
      const resultSource = result;
      void readCurrentSubjectSources({
        data: {
          id: result.kind === 'ready' ? result.page.id : '',
          locale: getLocale(),
          expectedReader: session.subject ?? null,
        },
        headers: csrfHeaders(),
      })
        .then((result) => {
          if (live) setCurrent({ source: resultSource, scope, result });
        })
        .catch(() => {
          if (live) setCurrent({ source: resultSource, scope, result: { kind: 'unavailable' } });
        });
    }
    return () => {
      live = false;
    };
  }, [result, scope, realm]);
  const selected =
    !realm && result.kind === 'ready' && (session.state === 'signed-in' || session.state === 'signed-out')
      ? current?.scope === scope && current.source === result
        ? current.result
        : { kind: 'loading' as const }
      : result;
  return (
    <SourcesPresentation
      result={currentReader ? selected : { kind: 'loading' }}
      reader={reader}
      {...(via ? { returnTo: via } : {})}
    />
  );
}

function SourcesError({ reset }: { reset: () => void }) {
  const via = Route.useSearch().via;
  return <SourcesPresentation result={{ kind: 'unavailable' }} reset={reset} {...(via ? { returnTo: via } : {})} />;
}

function SourcesPresentation({
  result,
  reader = null,
  reset,
  returnTo,
}: {
  result: SourcesResult | { kind: 'loading' };
  reader?: string | null;
  reset?: () => void;
  returnTo?: string;
}) {
  const search = Route.useSearch();
  const { realm } = search;
  const locale = getLocale();
  const session = useSession();
  const selection = sourceObservationSelection(search);
  const observation =
    result.kind === 'ready' && selection
      ? {
          ...selection,
          inspect: inspectSourceObservation,
          visitKey: JSON.stringify([
            result.page.id,
            realm,
            selection.source,
            selection.digest,
            locale,
            reader,
            session.state,
            session.subject,
            session.csrfToken,
          ]),
        }
      : undefined;
  const retry = useSourcesRetry({
    realm,
    reader,
    locale,
    loading: result.kind === 'loading',
    ...(reset ? { reset } : {}),
  });
  return (
    <SubjectSourcesPage
      result={result}
      locale={locale}
      {...(returnTo ? { returnTo } : {})}
      {...(observation ? { observation } : {})}
      {...retry}
    />
  );
}

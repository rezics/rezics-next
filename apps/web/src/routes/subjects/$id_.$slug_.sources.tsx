import { useEffect, useMemo, useState } from 'react';
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
import { SUMMARY_VISIT_ADDRESS_BYTE_CAP } from '../../features/pages/subject-summary-reading/visit';
import { subjectVisitReturn } from '../../features/pages/subject-visit-navigation';

const inspectSourceObservation = (request: SourceObservationRequest) =>
  inspectSubjectSourceObservation({ data: request });

/** Bind loader output without serializing the private comparison operands again. */
async function requestKey(request: { realm?: string | undefined; via?: string | undefined; locale: string }) {
  const bytes = new TextEncoder().encode(JSON.stringify([request.realm ?? null, request.via ?? null, request.locale]));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export const Route = createFileRoute('/subjects/$id_/$slug_/sources')({
  staticData: { publicCache: false },
  staleTime: 0,
  gcTime: 0,
  shouldReload: true,
  validateSearch: (search: Record<string, unknown>) => {
    const selection = sourceObservationSelection(search);
    const via = subjectVisitReturn(search.via, getLocale());
    if (search.via !== undefined && !via) throw new Error('Invalid synopsis visit');
    return {
      realm: validatePageRealm(search.realm),
      via,
      ...(selection ? { provider: selection.source, digest: selection.digest } : {}),
    };
  },
  loaderDeps: ({ search }) => ({ realm: search.realm, via: search.via }),
  loader: async ({ params, location, deps }) => {
    if (deps.via && new TextEncoder().encode(location.href).byteLength > SUMMARY_VISIT_ADDRESS_BYTE_CAP)
      throw new Error('Invalid synopsis visit');
    const reader = await subjectRequestReader({ data: { realm: deps.realm } });
    const result = await loadSubjectSources({
      data: {
        id: params.id,
        locale: getLocale(),
        ...(deps.realm ? { realm: deps.realm } : {}),
        ...(deps.via ? { via: deps.via } : {}),
        reader,
      },
    });
    if (result.kind === 'missing') throw notFound();
    if (result.kind === 'ready') {
      const canonical = subjectHref({ id: result.page.id, label: result.page.title.text }, getLocale());
      if (result.page.id !== params.id || canonical.params.slug !== params.slug)
        throw redirect(canonicalRedirect(result.page.sourcesHref.split('?', 1)[0]!, location.searchStr, location.hash));
    }
    return { result, reader, visit: crypto.randomUUID(), request: await requestKey({ ...deps, locale: getLocale() }) };
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
  const { result, reader, visit, request } = Route.useLoaderData();
  const { realm, via } = Route.useSearch();
  const locale = getLocale();
  // Capture the original attempt, then verify it against the loader's fingerprint.
  const original = useMemo(() => ({ realm, via, locale }), [visit]);
  const session = useSession();
  const currentReader = useSubjectReaderRefresh(reader, subjectReaderPartition(realm, reader, session));
  const scope = useMemo(() => ({}), [visit, realm, via, locale, session.state, session.subject, session.csrfToken]);
  const ownsRequest = original.realm === realm && original.via === via && original.locale === locale;
  const [current, setCurrent] = useState<{ source: SourcesResult; scope: object; result: SourcesResult }>();
  useEffect(() => {
    let live = true;
    setCurrent(undefined);
    if (ownsRequest)
      void (async () => {
        if ((await requestKey(original)) !== request || !live) return;
        const refreshed =
          !realm &&
          result.kind === 'ready' &&
          (session.state === 'signed-out' || (session.state === 'signed-in' && session.subject))
            ? await readCurrentSubjectSources({
                data: {
                  id: result.page.id,
                  locale: original.locale,
                  expectedReader: session.subject ?? null,
                  ...(original.via ? { via: original.via } : {}),
                },
                headers: csrfHeaders(),
              }).catch((): SourcesResult => ({ kind: 'unavailable' }))
            : result;
        if (live) setCurrent({ source: result, scope, result: refreshed });
      })();
    return () => {
      live = false;
    };
  }, [result, scope, realm, ownsRequest, request, original]);
  const selected =
    current?.scope === scope && current.source === result ? current.result : { kind: 'loading' as const };
  return (
    <SourcesPresentation
      result={currentReader && ownsRequest ? selected : { kind: 'loading' }}
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

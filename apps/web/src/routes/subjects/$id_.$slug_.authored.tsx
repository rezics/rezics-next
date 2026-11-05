import { editorRequest } from '../../features/catalogue/editor-request';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { candidateSession, useCandidateWork } from '../../subject/candidate-lifetime';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, notFound, redirect, useRouterState } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { Button } from '@rezics/ui/shadcn/button';
import { AuthoredField } from '../../features/catalogue/authored-field-view';
import {
  loadAuthoredField,
  submitAuthoredField,
  loadAuthoredReview,
  confirmAuthoredField,
} from '../../features/catalogue/authored-field-actions';
import { EditorFailure } from '../../features/catalogue/statement-editor-view';
import { csrfHeaders } from '../../threads/composer';
import { useSession } from '../../session/query';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';
import { canonicalRedirect, keepSearch } from '../../subject/subject-href';
import { synopsisVisit, SUMMARY_VISIT_ADDRESS_BYTE_CAP } from '../../features/pages/subject-summary-reading/visit';
import { SUMMARY_PROPERTY } from '../../features/pages/subject-summary-reading/model';
import { candidateContext } from '../../subject/candidates';

const canonicalAuthored = createServerFn({ method: 'GET', strict: false })
  .validator((value: { id: string; slug: string; locale: string; search: string }) => {
    if (
      !value ||
      typeof value.id !== 'string' ||
      value.id.length > 128 ||
      typeof value.slug !== 'string' ||
      value.slug.length > 128 ||
      typeof value.locale !== 'string' ||
      typeof value.search !== 'string' ||
      new TextEncoder().encode(value.search).byteLength > SUMMARY_VISIT_ADDRESS_BYTE_CAP
    )
      throw notFound();
    return value;
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const search = new URL(data.search, 'https://rezics.invalid').searchParams;
    const values = search.getAll('via');
    const visit = synopsisVisit(values.length > 1 ? '' : values[0], data.id, data.locale);
    // An unsupported reading must never borrow anonymous Global labels for its canonical identity.
    if (
      visit.kind === 'invalid' ||
      (visit.kind === 'selected' &&
        (visit.selection.realm ||
          visit.selection.context !== candidateContext ||
          search.get('property') !== SUMMARY_PROPERTY))
    )
      return { id: data.id };

    const [{ kernelClient }, { loadSubject }] = await Promise.all([
      import('../../kernel/client'),
      import('../../subject/load-subject'),
    ]);
    const canonical = await loadSubject(kernelClient(data.locale), data.id, data.locale as never);
    if (canonical.kind === 'missing') throw notFound();
    // The subject editor keeps the canonical subject id even when reading uses an account address.
    if (canonical.value.id !== data.id || canonical.value.slug !== data.slug) {
      const { subjectHref } = await import('../../subject/subject-href');
      throw redirect(
        canonicalRedirect(
          `${subjectHref({ id: canonical.value.id, label: canonical.value.label }, data.locale).href}/authored`,
          data.search,
        ),
      );
    }
    return { id: canonical.value.id };
  });

export const Route = createFileRoute('/subjects/$id_/$slug_/authored')({
  staticData: { publicCache: false },
  validateSearch: (input: Record<string, unknown>) => ({
    property: typeof input.property === 'string' && input.property.length <= 256 ? input.property : undefined,
  }),
  loader: ({ params, location }) =>
    canonicalAuthored({
      data: { ...params, locale: getLocale(), search: keepSearch('', location.searchStr, location.hash) },
    }),
  head: () => ({ meta: [{ title: m.authored_title() }, { name: 'robots', content: 'noindex' }] }),
  component: candidateSession(AuthoredRoute),
});

function AuthoredRoute() {
  const { id } = Route.useLoaderData();
  const { property } = Route.useSearch();
  const locale = getLocale();
  const location = useRouterState({ select: (state) => state.location });
  const values = new URLSearchParams(location.searchStr).getAll('via');
  const visit = synopsisVisit(values.length > 1 ? '' : values[0], id, locale);
  const unsupported =
    visit.kind === 'selected' && (!!visit.selection.realm || visit.selection.context !== candidateContext);
  const invalid = visit.kind === 'invalid' || (visit.kind === 'selected' && property !== SUMMARY_PROPERTY);
  const via = visit.kind === 'selected' || visit.kind === 'ordinary' ? visit.returnTo : undefined;
  const selectedVia = visit.kind === 'selected' ? via : undefined;
  const identity = JSON.stringify([id, locale, property, selectedVia, invalid, unsupported]);
  const candidateWork = useCandidateWork(identity);
  const editorWork = useCatalogueLifetime(identity);
  const currentFieldHref = `${location.pathname}?${new URLSearchParams({ property: SUMMARY_PROPERTY })}`;
  const { state } = useSession();
  const returnHref = via ?? (invalid ? location.pathname.replace(/\/authored$/u, '') : undefined);
  const returnLink = returnHref ? (
    <p className="px-6 text-sm">
      <a className="underline underline-offset-4" href={returnHref}>
        {m.subject_synopsis_return()}
      </a>
    </p>
  ) : null;
  const read = async (field = property, session?: string) => {
    const result = await loadAuthoredField({
      data: editorRequest({ id, property: field, session, via: selectedVia }, editorWork),
      headers: csrfHeaders(),
    });
    return editorWork.live() ? result : ({ ok: false, reason: 'denied' } as const);
  };
  const query = useQuery({
    queryKey: ['authored-field', identity, candidateWork.generation],
    queryFn: () => (candidateWork.live() ? read() : Promise.resolve({ ok: false, reason: 'denied' } as const)),
    enabled: state === 'signed-in' && !invalid && !unsupported,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if (invalid || unsupported)
    return (
      <div className="space-y-3 p-6">
        <h1 className="text-xl font-semibold">{m.authored_title()}</h1>
        <p role="status">{unsupported ? m.subject_synopsis_global_only() : m.subject_synopsis_visit_invalid()}</p>
        {returnLink}
      </div>
    );
  if (selectedVia && query.data && !query.data.ok)
    return (
      <div className="space-y-3 p-6">
        <h1 className="text-xl font-semibold">{m.authored_title()}</h1>
        <p role="status">{m.subject_synopsis_visit_changed()}</p>
        <EditorFailure reason={query.data.reason} locale={locale} />
        <a className="inline-flex min-h-11 items-center underline underline-offset-4" href={currentFieldHref}>
          {m.subject_synopsis_current_field()}
        </a>
        {returnLink}
      </div>
    );
  if (state === 'signed-out')
    return (
      <>
        <div className="p-6">
          <EditorFailure reason="denied" locale={locale} />
        </div>
        {returnLink}
      </>
    );
  if (query.isError && !query.data)
    return (
      <div className="space-y-3 p-6">
        <EditorFailure reason="unavailable" locale={locale} />
        <Button variant="outline" onClick={() => candidateWork.live() && void query.refetch()}>
          {m.correction_reload()}
        </Button>
        {returnLink}
      </div>
    );
  if (!query.data)
    return (
      <div>
        <p role="status" className="p-6">
          {m.candidate_loading()}
        </p>
        {returnLink}
      </div>
    );
  return (
    <>
      <AuthoredField
        key={editorWork.generation}
        initial={query.isError ? { ok: false, reason: 'unavailable' } : query.data}
        locale={locale}
        transport={{
          read,
          propose: (data) => submitAuthoredField({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
          review: (field, candidate, cursor, session, work) =>
            !work?.live()
              ? Promise.resolve({ comparison: { ok: false, reason: 'denied' }, body: null })
              : loadAuthoredReview({
                  data: {
                    id,
                    property: field,
                    candidate,
                    cursor,
                    session,
                    via: selectedVia,
                    expectedReader: work.reader,
                  },
                  headers: csrfHeaders(),
                }),
        }}
        confirm={(data, work) =>
          !work?.live()
            ? Promise.resolve({ ok: false, reason: 'denied' })
            : confirmAuthoredField({ data, headers: csrfHeaders() })
        }
      />
      {selectedVia && (
        <p className="px-6 text-sm">
          <a className="inline-flex min-h-11 items-center underline underline-offset-4" href={currentFieldHref}>
            {m.subject_synopsis_current_field()}
          </a>
        </p>
      )}
      {returnLink}
    </>
  );
}

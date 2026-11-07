import { useEffect, useRef, type ReactElement } from 'react';
import { editorRequest } from '../../features/catalogue/editor-request';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { candidateSession, useCandidateWork } from '../../subject/candidate-lifetime';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, notFound, redirect, useRouterState } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { Button } from '@rezics/ui/shadcn/button';
import { AuthoredField } from '../../features/catalogue/authored-field-view';
import { AuthoredPublicReturnLink, AuthoredPublicVisitNotice } from '../../features/catalogue/authored-field-entry';
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
import { SUMMARY_PROPERTY } from '../../features/pages/subject-summary-reading/contract';
import { candidateContext } from '../../features/pages/visit-host-port';
import {
  authoredGlobalVisitHref,
  authoredPublicVisitUnsupported,
  parseAuthoredPublicVisit,
  type AuthoredPublicVisit,
} from '../../features/catalogue/authored-public-visit';

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
    const canonicalPath = `/${encodeURIComponent(data.locale)}/subjects/${encodeURIComponent(data.id)}/${encodeURIComponent(data.slug)}/authored`;
    const publicVisit = parseAuthoredPublicVisit(data.search, data.id, data.locale, canonicalPath);
    if (publicVisit.kind === 'invalid' || authoredPublicVisitUnsupported(publicVisit))
      return { id: data.id, publicVisit };
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
      return { id: data.id, publicVisit };

    const { kernelClient } = await import('../../kernel/client');
    const { loadSubject } = await import('../../subject/load-subject');
    const canonical = await loadSubject(kernelClient(data.locale), data.id, data.locale as never);
    if (canonical.kind === 'missing') throw notFound();
    // The subject editor keeps the canonical subject id even when reading uses an account address.
    if (canonical.value.id !== data.id || canonical.value.slug !== data.slug) {
      const { subjectHref } = await import('../../subject/subject-href');
      const replacementSearch =
        canonical.value.id !== data.id && publicVisit.kind !== 'legacy'
          ? publicVisit.kind === 'fresh'
            ? '?publicReturn=!'
            : '?origin=!'
          : data.search;
      throw redirect(
        canonicalRedirect(
          `${subjectHref({ id: canonical.value.id, label: canonical.value.label }, data.locale).href}/authored`,
          replacementSearch,
        ),
      );
    }
    return { id: canonical.value.id, publicVisit };
  });

export const Route = createFileRoute('/subjects/$id_/$slug_/authored')({
  staticData: { publicCache: false },
  validateSearch: (input: Record<string, unknown>) => ({
    property: typeof input.property === 'string' && input.property.length <= 256 ? input.property : undefined,
  }),
  loader: ({ params, location }) => {
    const locale = getLocale();
    const search = keepSearch('', location.searchStr, location.hash);
    const canonicalPath = `/${encodeURIComponent(locale)}/subjects/${encodeURIComponent(params.id)}/${encodeURIComponent(params.slug)}/authored`;
    const publicVisit = parseAuthoredPublicVisit(search, params.id, locale, canonicalPath);
    if (publicVisit.kind === 'invalid' || authoredPublicVisitUnsupported(publicVisit))
      return { id: params.id, publicVisit };
    return canonicalAuthored({ data: { ...params, locale, search } });
  },
  head: () => ({ meta: [{ title: m.authored_title() }, { name: 'robots', content: 'noindex' }] }),
  component: AuthoredRoute,
});

function AuthoredRoute(): ReactElement {
  const { id } = Route.useLoaderData();
  const { property } = Route.useSearch();
  const locale = getLocale();
  const location = useRouterState({ select: (state) => state.location });
  const address = keepSearch('', location.searchStr, location.hash);
  const publicVisit = parseAuthoredPublicVisit(address, id, locale, location.pathname);
  const values = new URLSearchParams(location.searchStr).getAll('via');
  const synopsis = synopsisVisit(values.length > 1 ? '' : values[0], id, locale);
  const unsupported =
    synopsis.kind === 'selected' && (!!synopsis.selection.realm || synopsis.selection.context !== candidateContext);
  const invalid = synopsis.kind === 'invalid' || (synopsis.kind === 'selected' && property !== SUMMARY_PROPERTY);
  const via = synopsis.kind === 'selected' || synopsis.kind === 'ordinary' ? synopsis.returnTo : undefined;
  const selectedVia = synopsis.kind === 'selected' ? via : undefined;
  const failureIdentity = JSON.stringify([id, locale, property, selectedVia, invalid, unsupported]);
  const failureHeading = useRef<HTMLHeadingElement>(null);
  const focusedFailure = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!invalid && !unsupported) return;
    const target = failureHeading.current;
    if (!target || focusedFailure.current === failureIdentity) return;
    const document = target.ownerDocument;
    if (document.activeElement !== document.body && document.activeElement !== document.documentElement) return;
    focusedFailure.current = failureIdentity;
    target.focus();
  }, [failureIdentity, invalid, unsupported]);

  const fallbackReturnHref = `${location.pathname.replace(/\/authored$/u, '')}#connections`;
  if (publicVisit.kind === 'invalid' || authoredPublicVisitUnsupported(publicVisit))
    return (
      <div className="space-y-3 p-6">
        <h1 className="text-xl font-semibold">{m.authored_title()}</h1>
        <AuthoredPublicVisitNotice
          state={publicVisit.kind === 'invalid' ? 'invalid' : 'unsupported'}
          returnHref={publicVisit.kind === 'origin' ? publicVisit.origin.returnHref : fallbackReturnHref}
          freshHref={
            publicVisit.kind === 'origin'
              ? authoredGlobalVisitHref(location.pathname, id, locale, publicVisit.origin.returnHref)
              : undefined
          }
          locale={locale}
        />
      </div>
    );

  if (invalid || unsupported) {
    const returnHref = via ?? fallbackReturnHref;
    return (
      <div className="space-y-3 p-6">
        <h1
          ref={failureHeading}
          tabIndex={-1}
          className="text-xl font-semibold focus-visible:outline-2 focus-visible:outline-ring"
        >
          {m.authored_title()}
        </h1>
        <p role="status">{unsupported ? m.subject_synopsis_global_only() : m.subject_synopsis_visit_invalid()}</p>
        <p className="px-6 text-sm">
          <a className="underline underline-offset-4" href={returnHref}>
            {m.subject_synopsis_return()}
          </a>
        </p>
      </div>
    );
  }

  return (
    <AuthoredSessionRoute
      id={id}
      locale={locale}
      property={property}
      selectedVia={selectedVia}
      returnTo={via}
      publicVisit={publicVisit}
    />
  );
}

const AuthoredSessionRoute = candidateSession(AuthoredEditorRoute);

function AuthoredEditorRoute({
  id,
  locale,
  property,
  selectedVia,
  returnTo,
  publicVisit,
}: {
  id: string;
  locale: string;
  property?: string | undefined;
  selectedVia?: string | undefined;
  returnTo?: string | undefined;
  publicVisit: AuthoredPublicVisit;
}): ReactElement {
  const location = useRouterState({ select: (state) => state.location });
  const publicReturnHref =
    publicVisit.kind === 'origin'
      ? publicVisit.origin.returnHref
      : publicVisit.kind === 'fresh'
        ? publicVisit.returnHref
        : undefined;
  const identity = JSON.stringify([id, locale, property, selectedVia, returnTo, publicVisit]);
  const candidateWork = useCandidateWork(identity);
  const editorWork = useCatalogueLifetime(identity);
  const currentFieldHref = `${location.pathname}?${new URLSearchParams({ property: SUMMARY_PROPERTY })}`;
  const failureHeading = useRef<HTMLHeadingElement>(null);
  const focusedFailure = useRef<number>(undefined);
  const { state } = useSession();
  const returnLink = returnTo ? (
    <p className="px-6 text-sm">
      <a className="underline underline-offset-4" href={returnTo}>
        {m.subject_synopsis_return()}
      </a>
    </p>
  ) : publicReturnHref && publicVisit.kind === 'origin' ? (
    <p className="px-6 text-sm">
      <AuthoredPublicReturnLink href={publicReturnHref} locale={locale} />
    </p>
  ) : null;
  const freshNotice =
    publicVisit.kind === 'fresh' ? (
      <AuthoredPublicVisitNotice state="fresh" returnHref={publicVisit.returnHref} locale={locale} />
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
    enabled: state === 'signed-in',
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  useEffect(() => {
    const target = failureHeading.current;
    if (!target || !editorWork.active() || focusedFailure.current === editorWork.generation) return;
    const document = target.ownerDocument;
    if (document.activeElement !== document.body && document.activeElement !== document.documentElement) return;
    focusedFailure.current = editorWork.generation;
    target.focus();
  }, [editorWork, query.data]);
  if (selectedVia && query.data && !query.data.ok)
    return (
      <>
        {freshNotice}
        <div className="space-y-3 p-6">
          <h1
            ref={failureHeading}
            tabIndex={-1}
            className="text-xl font-semibold focus-visible:outline-2 focus-visible:outline-ring"
          >
            {m.authored_title()}
          </h1>
          <p role="status">{m.subject_synopsis_visit_changed()}</p>
          <EditorFailure reason={query.data.reason} locale={locale} />
          <a className="inline-flex min-h-11 items-center underline underline-offset-4" href={currentFieldHref}>
            {m.subject_synopsis_current_field()}
          </a>
          {returnLink}
        </div>
      </>
    );
  if (state === 'signed-out')
    return (
      <>
        {freshNotice}
        <div className="p-6">
          <EditorFailure reason="denied" locale={locale} />
        </div>
        {returnLink}
      </>
    );
  if (query.isError && !query.data)
    return (
      <>
        {freshNotice}
        <div className="space-y-3 p-6">
          <EditorFailure reason="unavailable" locale={locale} />
          <Button variant="outline" onClick={() => candidateWork.live() && void query.refetch()}>
            {m.correction_reload()}
          </Button>
          {returnLink}
        </div>
      </>
    );
  if (!query.data)
    return (
      <>
        {freshNotice}
        <div>
          <p role="status" className="p-6">
            {m.candidate_loading()}
          </p>
          {returnLink}
        </div>
      </>
    );
  return (
    <>
      {freshNotice}
      <AuthoredField
        key={editorWork.generation}
        initial={query.isError ? { ok: false, reason: 'unavailable' } : query.data}
        locale={locale}
        inspection={selectedVia}
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

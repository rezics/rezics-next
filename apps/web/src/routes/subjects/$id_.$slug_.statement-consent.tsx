import { candidateSession } from '../../subject/candidate-lifetime';
import { editorRequest } from '../../features/catalogue/editor-request';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { StatementConsentPage, ConsentError } from '../../features/catalogue/statement-consent-view';
import { consentSelection } from '../../features/catalogue/statement-consent';
import { readConsent, changeConsent, refreshConsentPublic } from '../../features/catalogue/statement-consent-actions';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';
import { canonicalRedirect, keepSearch, subjectHref } from '../../subject/subject-href';

const canonicalConsent = createServerFn({ method: 'GET', strict: false })
  .validator((value: { id: string; slug: string; locale: string; search: string }) => {
    if (
      !value ||
      typeof value.id !== 'string' ||
      value.id.length > 128 ||
      typeof value.slug !== 'string' ||
      value.slug.length > 128 ||
      typeof value.locale !== 'string' ||
      typeof value.search !== 'string' ||
      value.search.length > 4096
    )
      throw notFound();
    return value;
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const [{ kernelClient }, { loadSubject }] = await Promise.all([
      import('../../kernel/client'),
      import('../../subject/load-subject'),
    ]);
    const canonical = await loadSubject(kernelClient(data.locale), data.id, data.locale as never);
    if (canonical.kind === 'missing') throw notFound();
    if (canonical.value.id !== data.id || canonical.value.slug !== data.slug)
      throw redirect(
        canonicalRedirect(
          `${subjectHref({ id: canonical.value.id, label: canonical.value.label }, data.locale).href}/statement-consent`,
          data.search,
        ),
      );
    return { id: canonical.value.id };
  });
export const Route = createFileRoute('/subjects/$id_/$slug_/statement-consent')({
  staticData: { publicCache: false },
  validateSearch: (input: Record<string, unknown>) => {
    // Only addresses enter routing/SSR state. The private candidate is prepared after session hydration.
    try {
      const address = consentSelection({
        ...input,
        slot: { target: input.target, sameAs: input.sameAs, key: input.key },
      });
      return { property: address.property, candidate: address.candidate, ...address.slot };
    } catch {
      throw notFound();
    }
  },
  loader: ({ params, location }) =>
    canonicalConsent({
      data: { ...params, locale: getLocale(), search: keepSearch('', location.searchStr, location.hash) },
    }),
  head: () => ({ meta: [{ title: m.statement_consent_title() }, { name: 'robots', content: 'noindex' }] }),
  component: candidateSession(ConsentRoute),
});
function ConsentRoute() {
  const { id } = Route.useLoaderData();
  const { property, candidate, target, sameAs, key } = Route.useSearch();
  const address = { id, ...consentSelection({ property, candidate, slot: { target, sameAs, key } }) };
  const locale = getLocale();
  const editorWork = useCatalogueLifetime('transport');
  const { state } = useSession();
  if (state === 'signed-out')
    return (
      <div className="p-6">
        <ConsentError reason="denied" locale={locale} />
      </div>
    );
  if (state !== 'signed-in')
    return (
      <p role="status" className="p-6">
        {m.candidate_loading()}
      </p>
    );
  return (
    <StatementConsentPage
      key={`${id}:${candidate}:${property}:${target ?? ''}:${sameAs ?? ''}:${key ?? ''}:${locale}`}
      address={address}
      locale={locale}
      transport={{
        read: (cursor, session) =>
          readConsent({ data: editorRequest({ ...address, cursor, session }, editorWork), headers: csrfHeaders() }),
        change: (data) => changeConsent({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
        public: (session, terminal) =>
          refreshConsentPublic({
            data: editorRequest({ ...address, session, terminal }, editorWork),
            headers: csrfHeaders(),
          }),
      }}
    />
  );
}

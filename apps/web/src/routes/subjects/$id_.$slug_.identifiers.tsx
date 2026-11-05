import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { IdentifiersProfileSession } from '../../features/catalogue/identifiers-profile-session';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';
import { canonicalRedirect, keepSearch, subjectHref } from '../../subject/subject-href';
import {
  identifierOriginHref,
  identifierRouteHref,
  parseIdentifierCurrentVisit,
} from '../../features/catalogue/identifier-current-visit';

const canonicalIdentifiers = createServerFn({ method: 'GET', strict: false })
  .validator((input: { id: string; slug: string; locale: string; search: string }) => {
    if (
      !input ||
      typeof input.id !== 'string' ||
      input.id.length > 128 ||
      typeof input.slug !== 'string' ||
      input.slug.length > 128 ||
      typeof input.locale !== 'string' ||
      typeof input.search !== 'string' ||
      input.search.length > 2048
    )
      throw notFound();
    return input;
  })
  .handler(async ({ data }) => {
    const visit = parseIdentifierCurrentVisit(data.search);
    if (!visit) throw notFound();
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
          `${subjectHref({ id: canonical.value.id, label: canonical.value.label }, data.locale).href}/identifiers`,
          data.search,
        ),
      );
    let origin = visit.origin;
    if (origin?.kind === 'realm') {
      const { kernelClient: pageClient } = await import('../../kernel/client');
      const { loadSubjectPage, PageReadError } = await import('../../features/pages/subject');
      try {
        const loaded = await loadSubjectPage(pageClient(data.locale), canonical.value.id, undefined, data.locale, {
          realm: origin.realm,
        });
        if (loaded.kind === 'missing') origin = { ...origin, state: 'missing' };
        else if (loaded.kind === 'redirect') origin = { ...origin, state: 'changed' };
        else {
          const selected = loaded.page.context;
          if (
            loaded.page.subject === canonical.value.id &&
            loaded.page.requestedRealm === origin.realm &&
            selected &&
            selected?.population.kind === 'realm' &&
            selected.population.id === origin.realm &&
            (!origin.context || selected.id === origin.context)
          ) {
            origin = {
              ...origin,
              context: selected.id,
              realmTitle: selected.population.title,
              state: 'current',
            };
          } else origin = { ...origin, state: 'changed' };
        }
      } catch (error) {
        if (!(error instanceof PageReadError)) throw error;
        origin = {
          ...origin,
          state: error.status === 401 || error.status === 403 ? 'refused' : 'unavailable',
        };
      }
    }
    return {
      id: canonical.value.id,
      slug: canonical.value.slug,
      label: canonical.value.label,
      visit: { ...visit, ...(origin ? { origin } : {}) },
    };
  });

export const Route = createFileRoute('/subjects/$id_/$slug_/identifiers')({
  staticData: { publicCache: false },
  validateSearch: (input: Record<string, unknown>) => {
    if (
      Object.keys(input).some((key) => !['originContext', 'originRealm', 'reviewProperty', 'candidate'].includes(key))
    )
      throw notFound();
    return {
      originContext: typeof input.originContext === 'string' ? input.originContext : undefined,
      originRealm: typeof input.originRealm === 'string' ? input.originRealm : undefined,
      reviewProperty:
        typeof input.reviewProperty === 'string' && input.reviewProperty.length <= 256
          ? input.reviewProperty
          : undefined,
      candidate:
        typeof input.candidate === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.candidate)
          ? input.candidate
          : undefined,
    };
  },
  loader: ({ params, location }) =>
    canonicalIdentifiers({
      data: { ...params, locale: getLocale(), search: keepSearch('', location.searchStr, location.hash) },
    }),
  head: () => ({ meta: [{ title: m.identifiers_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: IdentifiersRoute,
});

function IdentifiersRoute() {
  const { id, slug, label, visit } = Route.useLoaderData();
  const locale = getLocale();
  const origin = visit.origin;
  const originHref = origin?.kind === 'realm' ? identifierOriginHref({ id, label }, locale, origin) : undefined;
  const globalHref = subjectHref({ id, label }, locale).href;
  const editorHref = identifierRouteHref(locale, id, slug, visit);
  return (
    <IdentifiersProfileSession
      key={`${id}:${locale}:${origin?.context ?? ''}:${origin?.realm ?? ''}:${origin?.realmTitle ?? ''}:${origin?.state ?? ''}:${visit.initialReview?.property ?? ''}:${visit.initialReview?.candidate ?? ''}`}
      id={id}
      locale={locale}
      initialReview={visit.initialReview}
      origin={origin}
      editorHref={editorHref}
      originHref={originHref}
      globalHref={globalHref}
    />
  );
}

import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { loadValueExplanation } from '../../features/catalogue/value-explanation-actions';
import { ValueExplanationPage } from '../../features/catalogue/value-explanation-page';
import { ValueExplanationSession } from '../../features/catalogue/value-explanation-session';
import { valueExplanationHref } from '../../features/catalogue/value-explanation';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { canonicalRedirect, subjectHref } from '../../subject/subject-href';

export const Route = createFileRoute('/subjects/$id_/$slug_/value')({
  staticData: { publicCache: false },
  validateSearch: (search: Record<string, unknown>) => ({
    property: typeof search.property === 'string' ? search.property : '',
    statement: typeof search.statement === 'string' ? search.statement : '',
    ...(typeof search.context === 'string' ? { context: search.context } : {}),
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ params, deps, location }) => {
    if (!deps.property || !deps.statement) return { kind: 'invalid' as const };
    const result = await loadValueExplanation({ data: { id: params.id, ...deps, locale: getLocale() } });
    if (result.kind === 'missing') throw notFound();
    if (result.kind === 'ready') {
      const identity = { id: result.page.id, label: result.page.title.text };
      if (subjectHref(identity, getLocale()).params.slug !== params.slug)
        throw redirect(
          canonicalRedirect(
            valueExplanationHref({ ...identity, title: identity.label, ...deps }, getLocale()),
            location.searchStr,
            location.hash,
          ),
        );
    }
    return result;
  },
  head: () => ({ meta: [{ title: m.value_why() }, { name: 'robots', content: 'noindex,nofollow' }] }),
  pendingComponent: () => <ValueExplanationPage locale={getLocale()} />,
  errorComponent: () => <ValueExplanationPage locale={getLocale()} result={{ kind: 'unavailable' }} />,
  component: ValueRoute,
});

function ValueRoute() {
  const { id } = Route.useParams();
  const search = Route.useSearch();
  const initial = Route.useLoaderData();
  const locale = getLocale();
  return <ValueExplanationSession id={id} address={search} locale={locale} episode={initial} />;
}

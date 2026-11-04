import { createFileRoute } from '@tanstack/react-router';
import { CollectionRuleCurrent } from '../../library/collection-rule-current';
import { readCollectionRule } from '../../library/collection-rule-actions';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { savedQueryRuleReturn } from '../../library/saved-query-results';

// Non-nested file routing keeps the private definition out of the public Collection reader's loader/cache.
export const Route = createFileRoute('/collections/$id_/rule')({
  beforeLoad: requireSignedIn,
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.returnTo === 'string' && search.returnTo.length <= 16_384 ? { returnTo: search.returnTo } : {}),
  }),
  loader: ({ params }) => readCollectionRule({ data: params.id }),
  head: ({ match }) =>
    pageHead({ title: m.library_rule_edit(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: EditRulePage,
});
function EditRulePage() {
  const loaded = Route.useLoaderData();
  const { id } = Route.useParams();
  const { returnTo } = Route.useSearch();
  const resultsHref = savedQueryRuleReturn(returnTo, id, getLocale());
  return (
    <CollectionRuleCurrent
      page={loaded}
      collectionId={id}
      resultsHref={resultsHref}
      navigate={(savedId) => {
        if (savedId === id) window.location.assign(savedQueryRuleReturn(resultsHref, id, getLocale(), true));
      }}
    />
  );
}

import { createFileRoute } from '@tanstack/react-router';
import { CollectionRuleCurrent } from '../../../library/collection-rule-current';
import { readCollectionRule } from '../../../library/collection-rule-actions';
import { requireSignedIn } from '../../../session/guard';
import { pageHead } from '../../../shell/head';
import { pageHeadContext } from '../../../shell/head-context';
import { getLocale } from '../../../paraglide/runtime.js';
import { m } from '../../../paraglide/messages.js';

export const Route = createFileRoute('/library/rules/new')({
  beforeLoad: requireSignedIn,
  loader: () => readCollectionRule({ data: undefined }),
  head: ({ match }) =>
    pageHead({ title: m.library_rule_new(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: NewRulePage,
});
function NewRulePage() {
  const loaded = Route.useLoaderData();
  return (
    <CollectionRuleCurrent
      page={loaded}
      collectionId={null}
      navigate={(id) => window.location.assign(`/${getLocale()}/collections/${encodeURIComponent(id)}`)}
    />
  );
}

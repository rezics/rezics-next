import { createFileRoute } from '@tanstack/react-router';
import { CollectionRuleCurrent } from '../../library/collection-rule-current';
import { readCollectionRule } from '../../library/collection-rule-actions';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { m } from '../../paraglide/messages.js';

// Non-nested file routing keeps the private definition out of the public Collection reader's loader/cache.
export const Route = createFileRoute('/collections/$id_/rule')({
  beforeLoad: requireSignedIn,
  loader: ({ params }) => readCollectionRule({ data: params.id }),
  head: ({ match }) =>
    pageHead({ title: m.library_rule_edit(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: EditRulePage,
});
function EditRulePage() {
  const loaded = Route.useLoaderData();
  const { id } = Route.useParams();
  return <CollectionRuleCurrent page={loaded} collectionId={id} />;
}

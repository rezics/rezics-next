import { createFileRoute } from '@tanstack/react-router';
import { CollectionRuleEditor } from '../../library/collection-rule-editor';
import {
  readCollectionRule,
  readCollectionRuleChoices,
  saveCollectionRule,
} from '../../library/collection-rule-actions';
import { requireSignedIn } from '../../session/guard';
import { useSession } from '../../session/query';
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
  const { csrfToken } = useSession();
  return (
    <CollectionRuleEditor
      key={id}
      page={loaded}
      csrfToken={csrfToken ?? ''}
      save={(data, csrf) => saveCollectionRule({ data, headers: { 'X-CSRF-Token': csrf } })}
      reload={() => readCollectionRule({ data: id })}
      labels={(q, cursor) => readCollectionRuleChoices({ data: { q, ...(cursor ? { cursor } : {}) } })}
    />
  );
}

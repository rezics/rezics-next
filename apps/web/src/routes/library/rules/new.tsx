import { createFileRoute } from '@tanstack/react-router';
import { CollectionRuleEditor } from '../../../library/collection-rule-editor';
import {
  readCollectionRule,
  readCollectionRuleChoices,
  saveCollectionRule,
} from '../../../library/collection-rule-actions';
import { requireSignedIn } from '../../../session/guard';
import { useSession } from '../../../session/query';
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
  const { csrfToken } = useSession();
  return (
    <CollectionRuleEditor
      page={loaded}
      csrfToken={csrfToken ?? ''}
      save={(data, csrf) => saveCollectionRule({ data, headers: { 'X-CSRF-Token': csrf } })}
      reload={() => readCollectionRule({ data: undefined })}
      labels={(q, cursor) => readCollectionRuleChoices({ data: { q, ...(cursor ? { cursor } : {}) } })}
      navigate={(id) => window.location.assign(`/${getLocale()}/collections/${encodeURIComponent(id)}`)}
    />
  );
}

import { createFileRoute } from '@tanstack/react-router';
import { SavedQueryEditor } from '../../../library/saved-query-editor/editor';
import { readCollectionRule } from '../../../library/collection-rule-actions';
import { requireSignedIn } from '../../../session/guard';
import { pageHead } from '../../../shell/head';
import { pageHeadContext } from '../../../shell/head-context';
import { m } from '../../../paraglide/messages.js';

export const Route = createFileRoute('/library/rules/new')({
  beforeLoad: requireSignedIn,
  loader: async () => ({ page: await readCollectionRule({ data: undefined }) }),
  head: ({ match }) =>
    pageHead({ title: m.library_rule_new(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: NewRulePage,
});
function NewRulePage() {
  const loaded = Route.useLoaderData();
  return (
    <SavedQueryEditor
      page={loaded.page}
      collectionId={null}
    />
  );
}

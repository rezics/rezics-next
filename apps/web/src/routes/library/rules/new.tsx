import { createFileRoute } from '@tanstack/react-router';
import { SavedQueryEditor } from '../../../library/saved-query-editor/editor';
import { admitSavedQueryInput, localPath, readSavedQuerySearch } from '../../../library/saved-query-editor/selection';
import { readCollectionRule } from '../../../library/collection-rule-actions';
import { requireSignedIn } from '../../../session/guard';
import { pageHead } from '../../../shell/head';
import { pageHeadContext } from '../../../shell/head-context';
import { getLocale } from '../../../paraglide/runtime.js';
import { m } from '../../../paraglide/messages.js';

export const Route = createFileRoute('/library/rules/new')({
  beforeLoad: requireSignedIn,
  loader: async ({ location }) => {
    const input = readSavedQuerySearch(location.searchStr);
    return {
      page: await readCollectionRule({ data: undefined }),
      selection: admitSavedQueryInput(input),
      originHref: localPath(input.from),
    };
  },
  head: ({ match }) =>
    pageHead({ title: m.library_rule_new(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: NewRulePage,
});
function NewRulePage() {
  const loaded = Route.useLoaderData();
  return (
    <SavedQueryEditor
      page={loaded.page}
      selection={loaded.selection}
      originHref={loaded.originHref}
      collectionId={null}
      navigate={(id) => window.location.assign(`/${getLocale()}/collections/${encodeURIComponent(id)}`)}
    />
  );
}

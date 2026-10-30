import { createFileRoute } from '@tanstack/react-router';
import { CreatorStatementsPage } from '../../../checkout/creator-statements-page';
import { readCreatorStatements, statementSearch } from '../../../checkout/creator-statements';
import { requireSignedIn } from '../../../session/guard';
import { pageHead } from '../../../shell/head';
import { pageHeadContext } from '../../../shell/head-context';
import { m } from '../../../paraglide/messages.js';
import { getLocale } from '../../../paraglide/runtime.js';

export const Route = createFileRoute('/creator/statements/')({
  beforeLoad: requireSignedIn,
  validateSearch: statementSearch,
  loaderDeps: ({ search }) => statementSearch(search),
  loader: ({ deps }) => readCreatorStatements({ data: deps }),
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.statements_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  pendingComponent: () => <CreatorStatementsPage page={{ kind: 'preparing' }} locale={getLocale()} />,
  component: function CreatorStatementsRoute() {
    const search = Route.useSearch();
    return <CreatorStatementsPage page={Route.useLoaderData()} locale={getLocale()} {...search} />;
  },
});

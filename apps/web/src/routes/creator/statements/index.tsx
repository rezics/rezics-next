import { createFileRoute } from '@tanstack/react-router';
import { CreatorStatementAddressRecovery } from '../../../checkout/creator-statement-address';
import { CreatorStatementsCurrent } from '../../../checkout/creator-statements-current';
import { CreatorStatementsPage } from '../../../checkout/creator-statements-page';
import {
  hasStatementAddressIssue,
  readCreatorStatementsCurrent,
  statementSearch,
} from '../../../checkout/creator-statements';
import { requireSignedIn } from '../../../session/guard';
import { pageHead } from '../../../shell/head';
import { pageHeadContext } from '../../../shell/head-context';
import { m } from '../../../paraglide/messages.js';
import { getLocale } from '../../../paraglide/runtime.js';

export const Route = createFileRoute('/creator/statements/')({
  beforeLoad: requireSignedIn,
  validateSearch: statementSearch,
  loaderDeps: ({ search }) => statementSearch(search),
  loader: ({ deps }) =>
    hasStatementAddressIssue(deps)
      ? undefined
      : readCreatorStatementsCurrent({ data: { ...deps, locale: getLocale() } }),
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.statements_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  pendingComponent: function CreatorStatementsPending() {
    const search = Route.useSearch();
    return <CreatorStatementsPage page={{ kind: 'preparing' }} locale={getLocale()} {...search} />;
  },
  component: function CreatorStatementsRoute() {
    const search = Route.useSearch();
    const initial = Route.useLoaderData();
    if (hasStatementAddressIssue(search)) return <CreatorStatementAddressRecovery kind="list" locale={getLocale()} />;
    return <CreatorStatementsCurrent initial={initial!} locale={getLocale()} {...search} />;
  },
});

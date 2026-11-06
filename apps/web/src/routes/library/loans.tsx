import { createFileRoute } from '@tanstack/react-router';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { requireSignedIn } from '../../session/guard';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { LoansCurrent } from '../../library/loans-current';
import { loansQuery } from '../../library/loans-query';
import { readLoansCurrent } from '../../library/loans-actions';

export const Route = createFileRoute('/library/loans')({
  beforeLoad: requireSignedIn,
  validateSearch: (search: Record<string, unknown>) => loansQuery(search),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => readLoansCurrent({ data: deps }),
  shouldReload: ({ cause }) => cause === 'enter',
  staleTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.library_loans_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: LoansRoute,
});

function LoansRoute() {
  const search = Route.useSearch();
  return <LoansCurrent initial={Route.useLoaderData()} search={search} locale={getLocale()} />;
}

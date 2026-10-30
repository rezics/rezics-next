import { createFileRoute } from '@tanstack/react-router';
import { CreatorStatementPage } from '../../../checkout/creator-statement-page';
import { readCreatorStatement, statementDetailSearch } from '../../../checkout/creator-statements';
import { requireSignedIn } from '../../../session/guard';
import { pageHead } from '../../../shell/head';
import { pageHeadContext } from '../../../shell/head-context';
import { m } from '../../../paraglide/messages.js';
import { getLocale } from '../../../paraglide/runtime.js';

export const Route = createFileRoute('/creator/statements/$id')({
  beforeLoad: requireSignedIn,
  validateSearch: statementDetailSearch,
  loaderDeps: ({ search }) => statementDetailSearch(search),
  loader: ({ params, deps }) =>
    readCreatorStatement({
      data: {
        id: params.id,
        ...(deps.cursor ? { cursor: deps.cursor } : {}),
      },
    }),
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.statements_detail_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  pendingComponent: () => <CreatorStatementPage page={{ kind: 'preparing' }} id="" locale={getLocale()} />,
  component: function CreatorStatementRoute() {
    const { cursor, from } = Route.useSearch();
    return (
      <CreatorStatementPage
        page={Route.useLoaderData()}
        id={Route.useParams().id}
        locale={getLocale()}
        {...(cursor ? { cursor } : {})}
        {...(from ? { from } : {})}
      />
    );
  },
});

import { createFileRoute } from '@tanstack/react-router';
import { CreatorStatementCurrent } from '../../../checkout/creator-statements-current';
import { CreatorStatementPage } from '../../../checkout/creator-statement-page';
import { readCreatorStatementCurrent, statementDetailSearch } from '../../../checkout/creator-statements';
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
    readCreatorStatementCurrent({
      data: {
        id: params.id,
        locale: getLocale(),
        ...(deps.from ? { from: deps.from } : {}),
        ...(deps.cursor ? { cursor: deps.cursor } : {}),
      },
    }),
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.statements_detail_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  pendingComponent: function CreatorStatementPending() {
    const search = Route.useSearch();
    return (
      <CreatorStatementPage page={{ kind: 'preparing' }} id={Route.useParams().id} locale={getLocale()} {...search} />
    );
  },
  component: function CreatorStatementRoute() {
    const { cursor, from } = Route.useSearch();
    return (
      <CreatorStatementCurrent
        initial={Route.useLoaderData()}
        id={Route.useParams().id}
        locale={getLocale()}
        {...(cursor ? { cursor } : {})}
        {...(from ? { from } : {})}
      />
    );
  },
});

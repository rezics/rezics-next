import { createFileRoute, notFound } from '@tanstack/react-router';
import { CreatorStatementAddressRecovery } from '../../../checkout/creator-statement-address';
import { CreatorStatementCurrent } from '../../../checkout/creator-statements-current';
import { CreatorStatementPage } from '../../../checkout/creator-statement-page';
import {
  hasStatementAddressIssue,
  isCreatorStatementId,
  readCreatorStatementCurrent,
  statementDetailSearch,
} from '../../../checkout/creator-statements';
import { requireSignedIn } from '../../../session/guard';
import { pageHead } from '../../../shell/head';
import { pageHeadContext } from '../../../shell/head-context';
import { m } from '../../../paraglide/messages.js';
import { getLocale } from '../../../paraglide/runtime.js';

export const Route = createFileRoute('/creator/statements/$id')({
  beforeLoad: requireSignedIn,
  validateSearch: statementDetailSearch,
  loaderDeps: ({ search }) => statementDetailSearch(search),
  loader: ({ params, deps }) => {
    if (!isCreatorStatementId(params.id)) throw notFound();
    if (hasStatementAddressIssue(deps)) return undefined;
    return readCreatorStatementCurrent({
      data: {
        id: params.id,
        locale: getLocale(),
        ...(deps.from ? { from: deps.from } : {}),
        ...(deps.cursor ? { cursor: deps.cursor } : {}),
      },
    });
  },
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
    const search = Route.useSearch();
    const id = Route.useParams().id;
    if (hasStatementAddressIssue(search))
      return <CreatorStatementAddressRecovery kind="detail" id={id} locale={getLocale()} {...search} />;
    return (
      <CreatorStatementCurrent
        initial={Route.useLoaderData()!}
        id={id}
        locale={getLocale()}
        {...search}
      />
    );
  },
});

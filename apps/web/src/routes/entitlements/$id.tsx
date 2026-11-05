import { purchaseHistorySearch } from '../../checkout/purchase-return';
import { createFileRoute } from '@tanstack/react-router';
import { EntitlementCurrent } from '../../checkout/entitlements-current';
import { readBuyerEntitlementCurrent } from '../../checkout/entitlements';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/entitlements/$id')({
  beforeLoad: requireSignedIn,
  validateSearch: purchaseHistorySearch,
  loader: ({ params }) => readBuyerEntitlementCurrent({ data: { id: params.id, locale: getLocale() } }),
  staleTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.entitlements_detail_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: function EntitlementRoute() {
    return (
      <EntitlementCurrent
        initial={Route.useLoaderData()}
        locale={getLocale()}
        id={Route.useParams().id}
        history={Route.useSearch()}
      />
    );
  },
});

import { purchaseHistorySearch } from '../../checkout/purchase-return';
import { createFileRoute } from '@tanstack/react-router';
import { EntitlementsCurrent } from '../../checkout/entitlements-current';
import { readBuyerEntitlementsCurrent } from '../../checkout/entitlements';
import {
  entitlementHistoryAddress,
  loadEntitlementHistoryAddress,
} from '../../checkout/entitlement-history-address';
import { EntitlementsAddressRecovery } from '../../checkout/entitlements-page';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/entitlements/')({
  beforeLoad: requireSignedIn,
  validateSearch: (search: Record<string, unknown>) => ({
    ...purchaseHistorySearch(search),
    address: entitlementHistoryAddress(search),
  }),
  loaderDeps: ({ search }) => search.address,
  loader: ({ deps }) =>
    loadEntitlementHistoryAddress(deps, (cursor) =>
      readBuyerEntitlementsCurrent({ data: { locale: getLocale(), ...(cursor === undefined ? {} : { cursor }) } }),
    ),
  staleTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.entitlements_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: function EntitlementsRoute() {
    const initial = Route.useLoaderData();
    const search = Route.useSearch();
    const locale = getLocale();
    if ('kind' in initial && initial.kind === 'malformed-address') {
      return <EntitlementsAddressRecovery locale={locale} history={search} />;
    }
    return (
      <EntitlementsCurrent
        initial={initial}
        locale={locale}
        cursor={search.address.kind === 'list' ? search.address.cursor : undefined}
        history={search}
      />
    );
  },
});

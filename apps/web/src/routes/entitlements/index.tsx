import { createFileRoute } from '@tanstack/react-router';
import { EntitlementsCurrent } from '../../checkout/entitlements-current';
import { entitlementSearch, readBuyerEntitlementsCurrent } from '../../checkout/entitlements';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/entitlements/')({
  beforeLoad: requireSignedIn,
  validateSearch: entitlementSearch,
  loaderDeps: ({ search }) => entitlementSearch(search),
  loader: ({ deps }) => readBuyerEntitlementsCurrent({ data: { ...deps, locale: getLocale() } }),
  staleTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.entitlements_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: function EntitlementsRoute() {
    return (
      <EntitlementsCurrent initial={Route.useLoaderData()} locale={getLocale()} cursor={Route.useSearch().cursor} />
    );
  },
});

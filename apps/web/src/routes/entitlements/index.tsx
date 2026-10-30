import { createFileRoute, useRouter } from '@tanstack/react-router';
import { EntitlementsPage } from '../../checkout/entitlements-page';
import { entitlementSearch, readBuyerEntitlements } from '../../checkout/entitlements';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/entitlements/')({
  beforeLoad: requireSignedIn,
  validateSearch: entitlementSearch,
  loaderDeps: ({ search }) => entitlementSearch(search),
  loader: ({ deps }) => readBuyerEntitlements({ data: { ...deps, locale: getLocale() } }),
  staleTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.entitlements_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: function EntitlementsRoute() {
    const router = useRouter();
    return (
      <EntitlementsPage
        page={Route.useLoaderData()}
        locale={getLocale()}
        continuation={Route.useSearch().cursor !== undefined}
        retry={() => {
          void router.invalidate();
        }}
      />
    );
  },
});

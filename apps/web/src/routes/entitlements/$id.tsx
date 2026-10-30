import { createFileRoute, useRouter } from '@tanstack/react-router';
import { EntitlementPage } from '../../checkout/entitlement-page';
import { readBuyerEntitlement } from '../../checkout/entitlements';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/entitlements/$id')({
  beforeLoad: requireSignedIn,
  loader: ({ params }) => readBuyerEntitlement({ data: { id: params.id, locale: getLocale() } }),
  staleTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.entitlements_detail_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: function EntitlementRoute() {
    const router = useRouter();
    return (
      <EntitlementPage
        page={Route.useLoaderData()}
        locale={getLocale()}
        retry={() => {
          void router.invalidate();
        }}
      />
    );
  },
});

import { createFileRoute, Outlet } from '@tanstack/react-router';
import { requireSignedIn } from '../../session/guard';
import { m } from '../../paraglide/messages.js';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { ZonesPending, ZonesRouteError } from '../../features/zones/manage/route-feedback';

export const Route = createFileRoute('/my/zones')({
  beforeLoad: requireSignedIn,
  pendingComponent: ZonesPending,
  errorComponent: ZonesRouteError,
  head: ({ match }) =>
    pageHead({ title: m.zones_owner_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: Outlet,
});

import { createFileRoute, Outlet } from '@tanstack/react-router';
import { requireSignedIn } from '../../session/guard';
import { m } from '../../paraglide/messages.js';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { ContextPending, ContextRouteError } from '../../features/contexts/session';

export const Route = createFileRoute('/my/contexts')({
  beforeLoad: requireSignedIn,
  staticData: { publicCache: false },
  pendingComponent: ContextPending,
  errorComponent: ContextRouteError,
  head: ({ match }) =>
    pageHead({ title: m.ctxw_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: Outlet,
});

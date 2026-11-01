import { createFileRoute } from '@tanstack/react-router';
import { changePlatformExposure, readPlatformExposureBound } from '../../platform/exposure/actions';
import { PlatformExposureBoundPage } from '../../platform/exposure/page';
import { m } from '../../paraglide/messages.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/platform/exposure')({
  beforeLoad: requireSignedIn,
  loader: () => readPlatformExposureBound({ data: {} }),
  head: ({ match }) =>
    pageHead({ title: m.exposure_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: ExposureRoute,
});
function ExposureRoute() {
  const initial = Route.useLoaderData();
  return (
    <PlatformExposureBoundPage
      initial={initial}
      io={{
        read: (query = {}) => readPlatformExposureBound({ data: query }),
        change: (operation, query, csrfToken) =>
          changePlatformExposure({ data: { operation, query }, headers: { 'X-CSRF-Token': csrfToken } }),
      }}
    />
  );
}

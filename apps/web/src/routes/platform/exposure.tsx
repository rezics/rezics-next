import { createFileRoute } from '@tanstack/react-router';
import { changePlatformExposure, readPlatformExposure } from '../../platform/exposure/actions';
import { PlatformExposurePage } from '../../platform/exposure/page';
import { m } from '../../paraglide/messages.js';
import { requireSignedIn } from '../../session/guard';
import { useSession } from '../../session/query';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/platform/exposure')({
  beforeLoad: requireSignedIn,
  loader: () => readPlatformExposure(),
  head: ({ match }) =>
    pageHead({ title: m.exposure_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: ExposureRoute,
});
function ExposureRoute() {
  const initial = Route.useLoaderData();
  const { csrfToken } = useSession();
  return (
    <PlatformExposurePage
      initial={initial}
      io={{
        read: () => readPlatformExposure(),
        change: (data) => changePlatformExposure({ data, headers: { 'X-CSRF-Token': csrfToken ?? '' } }),
      }}
    />
  );
}

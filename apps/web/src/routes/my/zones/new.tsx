import { createFileRoute, useLocation } from '@tanstack/react-router';
import { CreateZone } from '../../../features/zones/manage/create';
import { createMyZone } from '../../../features/zones/manage/actions';
import { getLocale } from '../../../paraglide/runtime.js';
import { m } from '../../../paraglide/messages.js';
import { useSession } from '../../../session/query';
import { pageHead } from '../../../shell/head';
import { pageHeadContext } from '../../../shell/head-context';
import { useOwnerLifetime } from '../../../features/zones/editor/owner-lifetime';
import type { CommandOutcome } from '../../../features/zones/manage/model';

export const Route = createFileRoute('/my/zones/new')({
  head: ({ match }) =>
    pageHead({ title: m.zones_owner_create(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: CreateZoneRoute,
});

function CreateZoneRoute() {
  const { state } = useSession();
  const locale = getLocale();
  const location = useLocation();
  const route = `${locale}:${location.pathname}:${JSON.stringify(location.search)}`;
  const { lifetime, snapshot } = useOwnerLifetime(route);
  return (
    <CreateZone
      key={`${route}:${snapshot.incarnation}`}
      owner={lifetime}
      locale={locale}
      session={state}
      onCreate={(command, admission): Promise<CommandOutcome> => {
        if (!lifetime.isCurrent(admission)) return Promise.resolve({ kind: 'stale' });
        return createMyZone({
          data: {
            ...command,
            expectedReader: admission.observation.reader,
            admission: admission.observation.admission,
          },
          headers: { 'X-CSRF-Token': admission.csrfToken ?? '' },
        });
      }}
      onNavigate={(href) => window.location.assign(href)}
    />
  );
}

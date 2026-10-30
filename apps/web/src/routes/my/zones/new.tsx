import { createFileRoute } from '@tanstack/react-router';
import { CreateZone } from '../../../features/zones/manage/create';
import { createMyZone } from '../../../features/zones/manage/actions';
import { getLocale } from '../../../paraglide/runtime.js';
import { m } from '../../../paraglide/messages.js';
import { useSession } from '../../../session/query';
import { pageHead } from '../../../shell/head';
import { pageHeadContext } from '../../../shell/head-context';

export const Route = createFileRoute('/my/zones/new')({
  head: ({ match }) =>
    pageHead({ title: m.zones_owner_create(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: CreateZoneRoute,
});

function CreateZoneRoute() {
  const { state, csrfToken } = useSession();
  return (
    <CreateZone
      locale={getLocale()}
      session={state}
      onCreate={(command) => createMyZone({ data: command, headers: { 'X-CSRF-Token': csrfToken ?? '' } })}
      onNavigate={(href) => window.location.assign(href)}
    />
  );
}

import { createFileRoute, useRouter } from '@tanstack/react-router';
import { ZonesOwnerWorkspace } from '../../../features/zones/manage/workspace';
import { changeMyZone, readMyZones } from '../../../features/zones/manage/actions';
import { listInput } from '../../../features/zones/manage/model';
import { getLocale } from '../../../paraglide/runtime.js';
import { useSession } from '../../../session/query';
import { ZonesPending, ZonesRouteError } from '../../../features/zones/manage/route-feedback';

export const Route = createFileRoute('/my/zones/')({
  validateSearch: listInput,
  loaderDeps: ({ search }) => listInput(search),
  loader: ({ deps }) => readMyZones({ data: deps }),
  pendingComponent: ZonesPending,
  errorComponent: ZonesRouteError,
  component: MyZonesRoute,
});

function MyZonesRoute() {
  const router = useRouter();
  const input = listInput(Route.useSearch());
  const outcome = Route.useLoaderData();
  const { csrfToken } = useSession();
  return (
    <ZonesOwnerWorkspace
      key={JSON.stringify(input)}
      locale={getLocale()}
      input={input}
      outcome={outcome}
      onChange={(command) => changeMyZone({ data: command, headers: { 'X-CSRF-Token': csrfToken ?? '' } })}
      onReload={() => router.invalidate()}
    />
  );
}

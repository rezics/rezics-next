import { createFileRoute } from '@tanstack/react-router';
import { RealmMembersPanel } from '../../community/members/panel';

export const Route = createFileRoute('/realms/$id_/members')({
  // No private roster, selection or command operand is loaded into public route data or metadata.
  staticData: { publicCache: false },
  component: MembersRoute,
});

function MembersRoute() {
  const { id } = Route.useParams();
  return <RealmMembersPanel realmId={id} />;
}

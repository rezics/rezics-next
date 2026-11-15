import { Link } from '@tanstack/react-router';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';

type ManagementObservation =
  | { kind: 'ready'; realm: { id: string } | null; permitted: { settings: boolean } }
  | { kind: 'failure' };

/** The host supplies an existing current realm:manage observation, never ban or add advice. */
export function RealmMembersEntry({
  realmId,
  appearance,
  setup,
}: {
  realmId: string;
  appearance: boolean;
  setup: ManagementObservation | null | undefined;
}) {
  // realm.update and appearance canManage both require native realm:manage. Space-only
  // grants and a successful ban list cannot admit this destination.
  const canManage = appearance || (setup?.kind === 'ready' && setup.realm?.id === realmId && setup.permitted.settings);
  if (!canManage) return null;
  return (
    <Button
      variant="outline"
      className="h-auto min-h-7 max-w-full whitespace-normal"
      nativeButton={false}
      render={<Link to="/realms/$id/members" params={{ id: realmId }} />}
    >
      {m.realm_members_heading()}
    </Button>
  );
}

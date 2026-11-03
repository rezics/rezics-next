import { Link } from '@tanstack/react-router';
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
    <Link
      to="/realms/$id/members"
      params={{ id: realmId }}
      className="inline-flex min-h-11 max-w-full items-center rounded-lg border px-4 py-2 text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
    >
      {m.realm_members_heading()}
    </Link>
  );
}

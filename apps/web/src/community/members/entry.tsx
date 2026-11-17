import { Link } from '@tanstack/react-router';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { m } from '../../paraglide/messages.js';

type ManagementObservation =
  | { kind: 'ready'; realm: { id: string } | null; permitted: { settings: boolean } }
  | { kind: 'failure' };

/** The host supplies an existing current realm:manage observation, never ban or add advice. */
export function RealmMembersEntry({
  realmId,
  nativeCanManage,
  appearance,
  setup,
}: {
  realmId: string;
  nativeCanManage?: boolean | undefined;
  appearance: boolean;
  setup: ManagementObservation | null | undefined;
}) {
  // The native home already checked realm:manage on this exact Realm. Older home
  // sources can use the matching settings or appearance admission.
  const canManage =
    nativeCanManage ??
    (appearance || (setup?.kind === 'ready' && setup.realm?.id === realmId && setup.permitted.settings));
  if (!canManage) return null;
  return (
    <Link
      to="/realms/$id/members"
      params={{ id: realmId }}
      className={cn(buttonVariants({ variant: 'outline' }), 'h-auto min-h-7 max-w-full whitespace-normal')}
    >
      {m.realm_members_heading()}
    </Link>
  );
}

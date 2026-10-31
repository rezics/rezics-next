import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { MessageSquarePlusIcon } from 'lucide-react';
import { RealmMembership } from '../community/realm-membership';
import { realmMembershipQuery } from '../community/realm-membership-queries';
import { personalRead } from '../kernel/query';
import { m } from '../paraglide/messages.js';
import { useSession } from '../session/query';
import type { CommunityBoardPage } from './board-feed-data';
import type { BoardRealm } from './board-context';
import type { BoardCommunitySource } from './board-community-source';
import { SignInPrompt } from './write-prompts';

type Board = CommunityBoardPage['board'];

/** A creation entry is not a permission grant; the existing composer command remains authoritative. */
export function BoardStartThread({
  board,
  realm,
  returnTo,
}: {
  board: Board;
  realm?: BoardRealm | undefined;
  returnTo: string;
}) {
  const { state: session, subject } = useSession();
  const available =
    board.availability === 'available' && board.visibility !== 'taken_down' && board.visibility !== 'draft';
  const membership = useQuery({
    ...realmMembershipQuery(board.realmId ?? '', session === 'signed-in' ? (subject ?? null) : null),
    enabled:
      personalRead.enabled && available && session === 'signed-in' && !!subject && !!realm && realm.state === 'active',
  });
  if (!available) return null;
  // A hidden/unavailable Realm never becomes a Global board.
  if (board.realmId !== null && (!realm || realm.state !== 'active')) return null;
  if (session === 'unavailable' || session === 'unknown') return null;
  if (session === 'signed-out') return <SignInPrompt returnTo={returnTo} label={m.board_sign_in_to_start()} compact />;
  if (!subject) return null;
  // A cached earlier success cannot override a failed refresh.
  if (
    board.realmId !== null &&
    (membership.isPending || membership.isFetching || membership.isError || !membership.data)
  )
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {membership.isError ? m.realm_membership_unavailable() : m.realm_membership_loading()}
      </p>
    );
  if (board.realmId !== null && membership.data?.state !== 'member' && membership.data?.state !== 'none') return null;
  return (
    <Link to="/boards/$id/new" params={{ id: board.id }} className={buttonVariants({ size: 'lg' })}>
      <MessageSquarePlusIcon aria-hidden="true" className="size-4" />
      {m.board_start_thread()}
    </Link>
  );
}

export function BoardParticipation({
  realm,
  community,
  returnTo,
}: {
  realm?: BoardRealm | undefined;
  community: BoardCommunitySource;
  returnTo: string;
}) {
  const { state: session } = useSession();
  if (!realm || realm.state !== 'active' || !realm.visibility) return null;
  if (session === 'unknown' || session === 'unavailable') return null;
  return (
    <RealmMembership
      realm={{ id: realm.id, visibility: realm.visibility, viewer: null }}
      returnTo={returnTo}
      memberLabel={m.board_community_joined()}
      admittedAction={community?.state === 'available' ? community.value.join.action : undefined}
    />
  );
}

import { Link } from '@tanstack/react-router';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { MessageSquarePlusIcon } from 'lucide-react';
import { RealmMembership } from '../community/realm-membership';
import { m } from '../paraglide/messages.js';
import { useSession } from '../session/query';
import type { CommunityBoardPage } from './board-feed-data';
import type { BoardCommunitySource } from './board-community-source';
import { SignInPrompt } from './write-prompts';

type Board = CommunityBoardPage['board'];
type BoardAdvice = CommunityBoardPage['actions']['createThread'];

/** The mounted page's current advice controls the entry; the composer command remains authoritative. */
export function BoardStartThread({
  board,
  advice,
  returnTo,
  preparedReturnTo,
}: {
  board: Board;
  advice: BoardAdvice;
  returnTo: string;
  preparedReturnTo?: string;
}) {
  const { state: session } = useSession();
  const available =
    board.availability === 'available' && board.visibility !== 'taken_down' && board.visibility !== 'draft';
  if (!available) return null;
  if (session === 'unavailable' || session === 'unknown') return null;
  if (session === 'signed-out')
    return advice === 'sign-in' ? (
      <SignInPrompt returnTo={returnTo} label={m.board_sign_in_to_start()} compact />
    ) : null;
  if (advice === 'unavailable')
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {m.realm_membership_unavailable()}
      </p>
    );
  if (advice !== 'allowed') return null;
  return (
    <Link
      to="/boards/$id/new"
      params={{ id: board.id }}
      search={preparedReturnTo ? { returnTo: preparedReturnTo } : {}}
      className={buttonVariants({ size: 'lg' })}
    >
      <MessageSquarePlusIcon aria-hidden="true" className="size-4" />
      {m.board_start_thread()}
    </Link>
  );
}

export function BoardParticipation({ community, returnTo }: { community: BoardCommunitySource; returnTo: string }) {
  const { state: session } = useSession();
  if (community?.state !== 'available') return null;
  if (session === 'unknown' || session === 'unavailable') return null;
  const { realmId, join } = community.value;
  if (join.action === null) return null;
  return (
    <RealmMembership
      realm={{ id: realmId, visibility: 'unknown', viewer: null }}
      returnTo={returnTo}
      memberLabel={m.board_community_joined()}
      admittedAction={join.action}
    />
  );
}

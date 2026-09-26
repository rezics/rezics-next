// Row declarations for migration 041. Mute, interaction block and resource policy
// are separate owners and effects; none of these rows grants or removes access.
import type { MembershipBasis } from './policy-schema.ts';

export const INTERACTION_KINDS = ['message', 'reply', 'mention'] as const;
export type InteractionKind = typeof INTERACTION_KINDS[number];

/** A block lives under the recipient's existing scope gate and its authority epoch. */
export function interactionScope(recipientSubject: string): string {
  return `interaction:${recipientSubject}`;
}

export type InteractionMutePreferenceRow = {
  principal_id: string; target: string; muted: boolean; revision: string; changed_at: Date;
} & ({ target_kind: 'realm'; match: 'publishing-realm' | 'author-membership' | 'publication-context' }
  | { target_kind: 'agent'; match: 'author' });

type InteractionBlockBase = {
  id: string; recipient_subject: string; scope_id: string; interactions: InteractionKind[];
  set_by_principal: string; set_by_representation_id: string;
  set_by_representation_generation: string; active: boolean; generation: string;
  created_at: Date;
};
export type InteractionBlockRow = InteractionBlockBase & (
  | { target_kind: 'agent'; target_subject: string; set_kind: null;
      set_owner_subject: null; basis: null }
  | { target_kind: 'member-set'; target_subject: null; set_kind: 'org' | 'realm';
      set_owner_subject: string; basis: MembershipBasis });

export type InteractionChangeReceiptRow = {
  principal_id: string; idempotency_key: string; request_digest: string; created_at: Date;
} & ({ action: 'mute' | 'unmute'; mute_revision: string; block_id: null;
    result_authority_epoch: null }
  | { action: 'block' | 'unblock'; mute_revision: null; block_id: string;
    result_authority_epoch: string });

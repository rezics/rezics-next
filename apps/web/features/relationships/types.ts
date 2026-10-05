import type { EntityPickerPage } from '@rezics/ui/entity-picker';

export type Level = 'all' | 'highlights' | 'off';
export type Source = 'explicit' | 'join' | 'library';
export type Order = 'recent' | 'pinned';
export type WatchLevel = 'participating' | 'all' | 'ignore';
export interface Name { value: string; language: string; direction?: 'ltr' | 'rtl' }
export interface FollowFields { level: Level; source: Source; pinPosition: number | null }
export interface Follow extends FollowFields {
  id: string; kind: string; revision: string; available: boolean;
  name: Name | null; icon: { kind: 'fallback'; key: string } | { kind: 'image'; url: string } | null;
  realm: string | null; href: string | null;
  newSince?: { state: string; count: { value: number; kind: 'exact' | 'lower-bound' } | null;
    updatedAt: string | null };
}
export interface FollowState {
  following: boolean | null; revision: string | null; level: Level | null; source: Source | null;
  pinPosition: number | null;
}
export interface FollowReceipt extends FollowFields {
  target: string; kind: string; following: boolean; revision: string;
}
export interface Membership {
  membershipId: string; generation: string; realm: string; space: string | null; member: string;
  available: boolean; name: Name | null; following: boolean; level: Level | null; source: Source | null;
  pinPosition: number | null;
}
export interface JoinPolicy {
  policyRevision: string; termsRevision: string; selfJoin: boolean; open: boolean;
  membershipGeneration: string; state: 'joined' | 'left' | 'absent';
}
export interface ListQuery { q?: string; kind?: string; order?: Order; cursor?: string | null; include?: 'newSince' }
export interface FollowEdit {
  target: string; kind?: string; following?: boolean; level?: Level; pinPosition?: number | null;
  expectedRevision?: string | null;
}
export interface Watch { level: WatchLevel; revision: string; reason: string }
export interface RelationshipsApi {
  /** Whether the adapter exposes Leave. Main still decides the reader's permission. */
  canLeave: boolean;
  follows(query?: ListQuery): Promise<EntityPickerPage<Follow>>;
  memberships(query?: Omit<ListQuery, 'kind' | 'include'>): Promise<EntityPickerPage<Membership>>;
  state(target: string, kind?: string): Promise<FollowState>;
  set(edit: FollowEdit & { following: boolean; expectedRevision: string | null }, key?: string): Promise<FollowReceipt>;
  batch(edits: FollowEdit[], key?: string): Promise<{ items: FollowReceipt[] }>;
  joining(realm: string): Promise<JoinPolicy>;
  join(realm: string, policy: JoinPolicy, listed: boolean, key?: string): Promise<unknown>;
  leave(realm: string, generation: string, key?: string): Promise<unknown>;
  mute(target: string, kind: string, muted: boolean, key?: string): Promise<unknown>;
  block(target: string, blocked: boolean, key?: string): Promise<unknown>;
  watch(target: string, kind: string): Promise<Watch | null>;
  setWatch(target: string, kind: string, level: WatchLevel, revision: string | null, key?: string): Promise<Watch>;
}

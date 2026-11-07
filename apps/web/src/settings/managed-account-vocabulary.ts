export type ManagedAccountActionsTarget = {
  accountId: string;
  nativeAccountKind: 'actor' | 'organization';
  operated: boolean;
  self: boolean;
};
export type ManagedActionName = 'profile' | 'rename' | 'members' | 'transfer' | 'delete';
export type Availability = { state: 'available' } | { state: 'denied' } | { state: 'unavailable'; owner: string };
export type AuthActionName = Exclude<ManagedActionName, 'profile'>;
type AuthAvailability = Exclude<Availability, { state: 'available' }> | { state: 'available'; href: string };
/** Web-private projection of a server-owned management GET, never an input to a native request. */
export type ManagedAuthNavigation = {
  accountId: string;
  viewerId: string;
  actions: Record<AuthActionName, AuthAvailability>;
};

export type ManagedAccountActionsResult =
  | {
      state: 'ready';
      accountId: string;
      viewerId: string;
      actions: Record<ManagedActionName, Availability>;
    }
  | { state: 'denied' | 'unavailable'; status: number | null; code: string | null; retryAfter?: string };
export type ManagedAccountActionsIO = (
  target: ManagedAccountActionsSelection,
  signal?: AbortSignal,
) => Promise<ManagedAccountActionsResult>;

export type ManagedAccountActionsSelection = { accountId: string; viewerId: string };

/** These presentation restrictions can only remove choices; native capability remains mandatory. */
export function managedAccountActionNames(target: ManagedAccountActionsTarget, viewerId: string): ManagedActionName[] {
  return [
    'profile',
    ...(target.self && target.accountId === viewerId && target.nativeAccountKind === 'actor' && !target.operated
      ? (['rename'] as const)
      : []),
    ...(target.nativeAccountKind === 'organization' ? (['members', 'delete'] as const) : []),
    ...(target.operated && target.nativeAccountKind === 'actor' ? (['transfer'] as const) : []),
  ];
}

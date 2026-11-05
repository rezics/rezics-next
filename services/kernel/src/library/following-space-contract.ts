export type FollowingSpaceDestination =
  | Readonly<{ kind: 'space'; spaceId: string; address: string }>
  | Readonly<{ kind: 'realm'; realmId: string }>
  | Readonly<{ kind: 'unavailable' }>;

export type FollowingSpaceActions =
  | Readonly<{
      status: 'available';
      resourceType: 'community.space' | 'community.realm';
      resourceId: string;
      viewerActions: Readonly<{ action: string; operations: string[] }>[];
    }>
  | Readonly<{ status: 'unavailable' }>;

export type FollowingSpaceProjection = Readonly<{
  target: Readonly<{ id: string; type: 'space'; label: string }> | null;
  destination: FollowingSpaceDestination;
  actions: FollowingSpaceActions;
}>;

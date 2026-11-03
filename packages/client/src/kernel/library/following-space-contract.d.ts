export type FollowingSpaceDestination =
    | {
          kind: "space";
          spaceId: string;
          address: string;
      }
    | {
          kind: "realm";
          realmId: string;
      }
    | {
          kind: "unavailable";
      };
export type FollowingSpaceActions =
    | {
          status: "available";
          resourceType: "community.space" | "community.realm";
          resourceId: string;
          viewerActions: {
              action: string;
              operations: string[];
          }[];
      }
    | {
          status: "unavailable";
      };
export type FollowingSpaceProjection = {
    target: {
        id: string;
        type: "space";
        label: string;
    } | null;
    destination: FollowingSpaceDestination;
    actions: FollowingSpaceActions;
};

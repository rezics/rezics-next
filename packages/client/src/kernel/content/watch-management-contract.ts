/** Watch inventory DTOs mirror the closed public schema owned by Kernel Content. */
export type WatchManagementKind = 'thread' | 'board';
export type WatchManagementAdvice = 'available' | 'denied';
export type WatchManagementViewer = { state: 'current'; accountId: string };
export type WatchManagementActions = { remove: WatchManagementAdvice };
export type WatchManagementCommand = {
  watchId: string;
  kind: WatchManagementKind;
  expectedRevision: number;
};

type WatchManagementIdentity = {
  id: string;
  kind: WatchManagementKind;
  revision: number;
  createdAt: string;
  command: WatchManagementCommand;
};

export type WatchManagementItem =
  | (WatchManagementIdentity & {
      state: 'available';
      resourceId: string;
      title: string | null;
    })
  | (WatchManagementIdentity & {
      state: 'unavailable';
    });

export type WatchManagementPage = {
  viewer: WatchManagementViewer;
  actions: WatchManagementActions;
  items: WatchManagementItem[];
  next: string | null;
};

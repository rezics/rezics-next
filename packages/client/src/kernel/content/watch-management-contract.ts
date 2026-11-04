/** Watch inventory DTOs mirror the closed public schema owned by Kernel Content. */
export type WatchManagementKind = 'thread' | 'board';

type WatchManagementIdentity = {
  id: string;
  kind: WatchManagementKind;
  revision: number;
  createdAt: string;
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
  items: WatchManagementItem[];
  next: string | null;
};

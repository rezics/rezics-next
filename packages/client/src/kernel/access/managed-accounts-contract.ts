/** Closed managed-account directory DTO owned by Kernel Access. e9314e51 publishes generated closure. */
export type ManagedAccountIdentity = {
  id: string;
  kind: 'actor' | 'organization';
  handle: string | null;
  displayName: string | null;
};

export type ManagedDirectoryNavigation =
  | { state: 'admitted' }
  | { state: 'unavailable' }
  | { state: 'concealed' };

export type ManagedAccountsViewer = {
  state: 'current';
  account: ManagedAccountIdentity;
};

export type ManagedOrganizationItem = {
  account: ManagedAccountIdentity;
  role: 'owner' | 'member';
  navigation: ManagedDirectoryNavigation;
};

export type ManagedResponsibilityItem = {
  reservationId: string;
  accountId: string;
  account: ManagedAccountIdentity | null;
  state: 'current' | 'reconciling';
  navigation: ManagedDirectoryNavigation;
};

export type ManagedAccountsPage = {
  account: ManagedAccountIdentity;
  viewer: ManagedAccountsViewer;
  organizations: {
    state: 'ready' | 'preparing';
    items: ManagedOrganizationItem[];
    next: string | null;
  };
  responsibilities: {
    items: ManagedResponsibilityItem[];
    next: string | null;
  };
};

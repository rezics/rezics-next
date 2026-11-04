import type { ManagedAccountsIO, ManagedAccountsPage } from '../../settings/managed-accounts-read';

export const managedViewer = '019a0000-0000-7000-8000-000000000001';
export function managedAccountsExample(): ManagedAccountsPage {
  return {
    account: { id: managedViewer, kind: 'actor', handle: 'avery', displayName: 'Avery Reader' },
    organizations: {
      state: 'ready',
      items: [
        {
          account: {
            id: '019a0000-0000-7000-8000-000000000002',
            kind: 'organization',
            handle: 'atlas-editors',
            displayName: 'Atlas Editors',
          },
          role: 'owner',
        },
        {
          account: {
            id: '019a0000-0000-7000-8000-000000000003',
            kind: 'organization',
            handle: null,
            displayName: 'Independent Reading Group',
          },
          role: 'member',
        },
      ],
      next: 'illustrative organization +/=',
    },
    responsibilities: {
      items: [
        {
          reservationId: '019a0000-0000-7000-8000-000000000004',
          accountId: '019a0000-0000-7000-8000-000000000005',
          account: {
            id: '019a0000-0000-7000-8000-000000000005',
            kind: 'actor',
            handle: 'atlas-indexer',
            displayName: 'Atlas Indexer',
          },
          state: 'current',
        },
        {
          reservationId: '019a0000-0000-7000-8000-000000000006',
          accountId: '019a0000-0000-7000-8000-000000000007',
          account: null,
          state: 'reconciling',
        },
      ],
      next: 'illustrative operator +/=',
    },
  };
}

/** Illustrative retained IO only; official current-viewer/navigation publication and native evidence remain pending. */
export function managedAccountsIO(
  scenario: 'independent' | 'preparing' | 'reconciling' = 'independent',
): ManagedAccountsIO {
  let failed = false;
  return async (cursors) => {
    const page = managedAccountsExample();
    if (scenario === 'preparing') page.organizations = { state: 'preparing', items: [], next: null };
    if (scenario === 'reconciling') {
      page.organizations.next = null;
      page.responsibilities.next = null;
      page.responsibilities.items[0]!.state = 'reconciling';
    }
    if (cursors.organizationsCursor && !failed) {
      failed = true;
      return { ok: false, kind: 'unavailable', status: 503, code: 'dependency_unavailable' };
    }
    if (cursors.organizationsCursor)
      page.organizations = {
        state: 'ready',
        items: [],
        next:
          cursors.organizationsCursor === 'illustrative organization +/=' ? 'illustrative filtered continuation' : null,
      };
    if (cursors.operatorsCursor) page.responsibilities = { items: [], next: null };
    return { ok: true, page };
  };
}

import type {
  MyRealmsCurrentActionName,
  MyRealmsCurrentAdvice,
  MyRealmsCurrentPage,
  MyRealmsCurrentRow,
  MyRealmsNativePage,
} from './contract';

const actionContract = {
  enter: (realmId: string) => ({ method: 'GET', path: `/v1/realms/${realmId}`, expectedStatus: 200 }),
  manage: (realmId: string) => ({ method: 'GET', path: `/v1/realms/${realmId}/settings`, expectedStatus: 200 }),
  leave: (realmId: string) => ({ method: 'DELETE', path: `/v1/realms/${realmId}/membership`, expectedStatus: 202 }),
} as const;

function verifyAdvice(action: MyRealmsCurrentActionName, realmId: string, advice: MyRealmsCurrentAdvice): void {
  if (advice.state !== 'available') return;
  const expected = actionContract[action](realmId);
  if (
    advice.method !== expected.method ||
    advice.path !== expected.path ||
    advice.body !== null ||
    advice.expectedStatus !== expected.expectedStatus
  )
    throw new Error(`My Realms ${action} advice did not match its installed Realm operation`);
}

function verifyRow(row: MyRealmsNativePage['items'][number]): MyRealmsCurrentRow {
  if (
    row.current.destination.kind !== 'realm' ||
    row.current.destination.realmId !== row.realmId ||
    row.current.viewer.readability !== 'allowed' ||
    row.current.viewer.membership.state !== 'member' ||
    row.current.actions.state !== 'current'
  )
    throw new Error('My Realms current source changed');
  for (const action of ['enter', 'manage', 'leave'] as const)
    verifyAdvice(action, row.realmId, row.current.actions[action]);
  return { realmId: row.realmId, name: row.name, current: row.current };
}

/** Project one installed native page without deriving authority, refilling sparse windows or reading each row. */
export function formatMyRealmsCurrent(page: MyRealmsNativePage): MyRealmsCurrentPage {
  if (page.items.length > 20) throw new Error('My Realms page exceeded its installed page bound');
  return {
    realms: page.items.map(verifyRow),
    next: page.next,
  };
}

export function myRealmsAdvice(row: MyRealmsCurrentRow, action: MyRealmsCurrentActionName): MyRealmsCurrentAdvice {
  return row.current.actions[action];
}

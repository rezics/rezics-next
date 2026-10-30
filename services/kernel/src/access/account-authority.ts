import { createResourcePublicEligibility } from './eligibility.ts';
import { accessNativeDeclaration, EMPTY_ACCESS_WORK } from './work.ts';
import type { AccessClient } from '../request/access.ts';
import type { Account } from './account-data.ts';
import { readAccountActionStates } from './account-viewer-actions.ts';
import { accessNativeWork, type AccessWorkAccounting } from './work.ts';
import { routeOf } from '../route/route.ts';

/** Only native permission facts; never manufacture a full private Account. */
export type PermissionAccount = Pick<
  Account,
  'route' | 'accountId' | 'kind' | 'state' | 'fenced' | 'operatorAccountId' | 'minimumAuthnEpoch'
>;

/** Exact installed account-viewer-actions.sql projection, bounded by full keys.
 * Neither profile text nor bearer material enters the statement or receipt.
 */
export function readNativeAccountStates(client: AccessClient, ids: readonly string[], work?: AccessWorkAccounting) {
  if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length || ids.some((id) => routeOf(id) === null))
    throw new RangeError('Invalid native Account keys');
  return accessNativeWork(
    work,
    'account-state',
    { routes: ids.map((id) => routeOf(id)!), ids: [...ids] },
    { targets: ids.length },
    () => readAccountActionStates(client, ids),
  );
}

export async function readNativePermissionAccount(
  client: AccessClient,
  id: string,
  work: AccessWorkAccounting,
): Promise<PermissionAccount | null> {
  const row = (await readNativeAccountStates(client, [id], work))[0];
  return row
    ? {
        route: routeOf(id)!,
        accountId: row.id,
        kind: row.kind,
        state: row.state,
        fenced: row.fenced,
        operatorAccountId: row.operatorAccountId,
        minimumAuthnEpoch: BigInt(row.minimumAuthnEpoch),
      }
    : null;
}

/** Native public-account floor. The owner receipt describes the SAME one full-key
 * statement executed by verify; preparation is genuinely synchronous zero IO.
 */
export function createAccountPublicEligibility(target: import('../request/access.ts').Resource) {
  const resource = Object.freeze({ route: target.route, id: target.id });
  if (routeOf(resource.id) !== resource.route) throw new RangeError('Invalid Account floor key');
  type VerifyInput = import('./eligibility.ts').ResourceEligibilityVerifyContext<true>;
  const receipts = new WeakMap<VerifyInput, import('./work.ts').AccessWork>();
  const declaration = () =>
    accessNativeDeclaration('account-state', { routes: [resource.route], ids: [resource.id] }, { targets: 1 });
  return createResourcePublicEligibility({
    resource,
    action: 'account:read_public_identity',
    work: {
      prepare: { bound: () => EMPTY_ACCESS_WORK, actual: () => EMPTY_ACCESS_WORK },
      verify: { bound: () => declaration().bound, actual: (input) => receipts.get(input) },
    },
    async prepare() {
      return true as const;
    },
    async verify(input: VerifyInput) {
      const rows = await readAccountActionStates(input.client, [resource.id]);
      receipts.set(input, declaration().actual(rows));
      return rows[0]?.state === 'active' && rows[0].fenced === false;
    },
  });
}

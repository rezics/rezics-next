import {
  ACCESS_WORKFLOW_KEY_MAX,
  ACCESS_WORKFLOW_KEY_MIN,
  isAccessAccountActor,
  RealmClaimDeniedError,
  type AccessApplicationPorts,
  type ApproveRealmClaimApplicationInput,
  type RealmClaimApprovalResult,
} from '../contract/index.ts';

export { RealmClaimDeniedError };

function routeOf(id: string): number | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return null;
  return Number.parseInt(id.slice(0, 4), 16) & 0xffff;
}

export function createRealmAdministration(ports: Pick<AccessApplicationPorts, 'realm'>) {
  return {
    async approveRealmClaim(input: ApproveRealmClaimApplicationInput): Promise<RealmClaimApprovalResult> {
      const { actor, realmId, requestId, deadline, idempotencyKey } = input;
      const route = routeOf(realmId);
      if (
        !isAccessAccountActor(actor) ||
        route === null ||
        routeOf(requestId) !== route ||
        !Number.isFinite(deadline) ||
        typeof idempotencyKey !== 'string' ||
        idempotencyKey.length < ACCESS_WORKFLOW_KEY_MIN ||
        idempotencyKey.length > ACCESS_WORKFLOW_KEY_MAX
      ) {
        throw new RealmClaimDeniedError();
      }
      return input.runCommand(async (tx, command) => {
        const source = await ports.realm.lockClaimApprovalSource(tx, { realmId, requestId });
        if (!source) throw new RealmClaimDeniedError();
        await input.grantOwner(tx, { route, id: realmId }, source.claimantAccountId, command.transactionId);
        return ports.realm.applyClaimApproval(tx, source);
      });
    },
  };
}

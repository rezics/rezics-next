import type { Pool } from 'pg';
import { authoritativeTimeValue, type AuthoritativeTime } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Access, type AccessClient, type AccountActor, type AccessCheck } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { AccountManagementPage, ManagedAuthOperationId } from './account-management.ts';
import { readAccount, readOrganizationRole, type Account } from './account-data.ts';
import { deadlineClient, within } from './authenticate.ts';
import { deriveAccess } from './derived-access.ts';
import assignmentRead from './delegation-read.sql';
import { ManagementSourceRefusedError, readNativeOperatorTransferRelation } from './management-source.ts';
import { permissionEvidenceDeadline } from './permission.ts';
import { classifyUnavailability, CommandUnavailableError, requireAccessDeadline } from './unavailable.ts';
import { managedAuthWorkflowDescriptor } from './workflow-approvals.ts';

type Actions = NonNullable<AccountManagementPage['authActions']>;
type Entry = Extract<Actions, { state: 'ready' }>['operations'][number];
type Relation = AccountManagementPage['relation'];
const unavailable = { state: 'unavailable' } as const;
class EntrySourceUnavailable extends Error {}
const active = (account: Account | null): account is Account =>
  !!account && account.state === 'active' && !account.fenced;
const human = (account: Account | null): account is Account =>
  active(account) && account.kind === 'actor' && account.operatorAccountId === null;

/** ENTRY observations only. No workflow input, approval, destination or route deployment is inferred. */
export async function readManagedAuthActions(
  deps: { pool: Pool; access: Access },
  actor: AccountActor,
  selection: { account: Account; relation: Relation },
  context: { deadline: number; time: AuthoritativeTime },
): Promise<Actions> {
  if (!deps.access.prepare) return unavailable;
  const { deadline, time } = context;
  const targetId = selection.account.accountId;
  const at = new Date(authoritativeTimeValue(time));
  const snapshot = <T>(read: (client: AccessClient) => Promise<T>) =>
    within(deadline, () =>
      withConnection(deps.pool, async (connection) => {
        const client = deadlineClient(connection, deadline);
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          const value = await read(client);
          requireAccessDeadline(deadline);
          await client.query('COMMIT');
          return value;
        } catch (error) {
          try {
            await connection.query('ROLLBACK');
          } catch (rollbackError) {
            discardConnection(connection, rollbackError as Error);
          }
          throw error;
        }
      }),
    );
  async function source(client: AccessClient) {
    const homes = new Map<number, number>();
    async function home(accountId: string) {
      const partition = partitionOf(routeOf(accountId)!);
      if (homes.has(partition)) return;
      const row = await readPartition(client, partition);
      if (!row) throw new CommandUnavailableError('contention', partition);
      if (row.writeState !== 'active') throw new CommandUnavailableError(row.writeState, partition, row.movedTo);
      homes.set(partition, row.epoch);
    }
    await home(actor.accountId);
    await home(targetId);
    const currentHuman = await readAccount(client, routeOf(actor.accountId)!, actor.accountId);
    const target = await readAccount(client, routeOf(targetId)!, targetId);
    const entries: Entry[] = [];
    const observed: unknown[] = [];
    let admitted =
      human(currentHuman) &&
      Number.isSafeInteger(actor.authnEpoch) &&
      actor.authnEpoch >= 1 &&
      BigInt(actor.authnEpoch) >= currentHuman.minimumAuthnEpoch &&
      active(target) &&
      target.kind === selection.account.kind &&
      target.operatorAccountId === selection.account.operatorAccountId;
    if (actor.requestedBy !== null) {
      const reference = /^urn:rezics:request:([^:]+):([^:]+)$/.exec(actor.requestedBy);
      if (!reference || routeOf(reference[1]!) === null || routeOf(reference[2]!) === null) admitted = false;
      else {
        await home(reference[1]!);
        const principal = await readAccount(client, routeOf(reference[1]!)!, reference[1]!);
        const assignment = await assignmentRead.run(client, {
          route: routeOf(reference[1]!)!,
          principal_id: reference[1]!,
          request_id: reference[2]!,
          actor_id: actor.accountId,
          at: authoritativeTimeValue(time),
        });
        admitted &&= human(principal) && !!assignment;
        observed.push(principal?.minimumAuthnEpoch.toString(), assignment?.valid);
      }
    }
    function entry(
      operationId: ManagedAuthOperationId,
      kind: Parameters<typeof managedAuthWorkflowDescriptor>[0],
      id: string,
    ) {
      const descriptor = managedAuthWorkflowDescriptor(kind, id);
      entries.push({
        operationId,
        action: descriptor.action,
        resource: { route: routeOf(descriptor.target)!, id: descriptor.target },
      });
    }
    if (admitted && target) {
      if (target.kind === 'organization') {
        const role = await readOrganizationRole(client, target.route, targetId, actor.accountId, at);
        observed.push(role);
        if (role) {
          entry('auth.organization.membership', 'membership', targetId);
          entry('auth.organization.delete', 'delete', targetId);
        }
      } else if (targetId === actor.accountId && target.operatorAccountId === null) {
        entry('auth.account.rename', 'rename', targetId);
      } else if (target.operatorAccountId !== null) {
        const relation = await readNativeOperatorTransferRelation(client, targetId);
        const operatorId = target.operatorAccountId;
        await home(operatorId);
        const operator = await readAccount(client, routeOf(operatorId)!, operatorId);
        const role =
          operator?.kind === 'organization'
            ? await readOrganizationRole(client, operator.route, operatorId, actor.accountId, at)
            : null;
        observed.push(relation, operator?.state, operator?.fenced, operator?.operatorAccountId, role);
        if (
          relation &&
          selection.relation &&
          relation.previous.operatorAccountId === operatorId &&
          relation.previous.reservationId === selection.relation.reservationId &&
          relation.expectedVersion === selection.relation.version &&
          selection.relation.operatorAccountId === operatorId &&
          active(operator) &&
          operator.operatorAccountId === null &&
          (operator.kind === 'organization' ? !!role : operatorId === actor.accountId)
        )
          entry('auth.operator.transfer', 'transfer', operatorId);
      }
    }
    // Lifecycle, relation, membership and home changes during released preparation
    // invalidate the whole observation. Role names can only remove candidates.
    return {
      entries,
      homes: JSON.stringify([...homes].sort(([a], [b]) => a - b)),
      identity: JSON.stringify([
        admitted,
        target?.kind,
        target?.state,
        target?.fenced,
        target?.operatorAccountId,
        currentHuman?.minimumAuthnEpoch.toString(),
        ...observed,
        entries,
      ]),
    };
  }
  try {
    const before = await snapshot(source);
    // The native opaque evidence registry prevents a raw callback/setter from
    // standing in for the installed action-general formula.
    const access = deriveAccess(deps.access, {
      async prepare(...args) {
        const evidence = await deps.access.prepare!(...args);
        if (permissionEvidenceDeadline(evidence) === undefined) throw new EntrySourceUnavailable();
        return evidence;
      },
    });
    const checks: AccessCheck[] = [];
    // All foreign preparation completes with no source connection held.
    for (const entry of before.entries) {
      checks.push(await accessCheck(access, actor, entry.action, entry.resource, { pool: deps.pool, deadline, time }));
    }
    return await snapshot(async (client): Promise<Actions> => {
      const current = await source(client);
      if (current.homes !== before.homes) return unavailable;
      if (current.identity !== before.identity) return { state: 'ready', operations: [] };
      const operations: Entry[] = [];
      for (const [index, check] of checks.entries()) {
        if (await check(client, time)) operations.push(before.entries[index]!);
      }
      return { state: 'ready', operations };
    });
  } catch (error) {
    if (error instanceof EntrySourceUnavailable || classifyUnavailability(error)) return unavailable;
    if (error instanceof ManagementSourceRefusedError) return { state: 'ready', operations: [] };
    return unavailable;
  }
}

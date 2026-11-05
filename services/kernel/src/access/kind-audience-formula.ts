/** SQL-derived envelope for the installed evaluator's Kind-only original call.
 * This computes work, never role evidence, membership, a decision or a closure.
 */
import type { Actor, AccessContext, ActionCatalogue } from '../request/access.ts';
import type { WorkDimensions } from '../library/collection-source.ts';
import { accessNativeDeclaration, addAccessWork, EMPTY_ACCESS_WORK, type AccessWork } from './work.ts';
import { MEMBERSHIP_LIMIT } from './membership-inverse.ts';
import { resolveResourceRoles, type ResourceRoleCatalogue } from './resource-roles.ts';
import timeRead from './permission-time.sql';
import assignmentRead from './permission-assignment.sql';
import inverseRead from './permission-inverse.sql';
import membershipRead from './permission-membership.sql';
import permissionRead from './permission-check.sql';
import openingRead from './gates/opening-read.sql';
import partitionRead from './gates/opening-partition-read.sql';
import movedRead from './gates/opening-moved-target-read.sql';

export function kindOriginalFormulaPlan(
  actor: Actor,
  context: AccessContext,
  actions: ActionCatalogue,
  resourceRoles?: ResourceRoleCatalogue,
): Readonly<{ access: AccessWork | undefined; overhead: WorkDimensions }> {
  const overhead: WorkDimensions = Object.freeze({
    candidateKeys: 0,
    nativeRows: 0,
    nativePoints: 4,
    identityMetadataRows: 0,
    witnessKeys: 0,
    emptySeeks: 0,
    statements: 13,
    bytes: [
      timeRead.sql,
      assignmentRead.sql,
      inverseRead.sql,
      membershipRead.sql,
      permissionRead.sql,
      permissionRead.sql,
      permissionRead.sql,
      openingRead.sql,
      partitionRead.sql,
      movedRead.sql,
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'COMMIT',
      'ROLLBACK',
    ].reduce((n, sql) => n + Buffer.byteLength(sql), 0),
  });
  if (!actions.has('collection:read') || !Number.isFinite(context.deadline) || !context.time || !context.work)
    return { access: undefined, overhead };
  const members = actor.kind === 'account' ? (actor.requestedBy ? 2 : 1) : 0;
  const groups = members * MEMBERSHIP_LIMIT;
  const roles = groups * 2;
  const scope = actor.kind === 'account' && actor.scopes.includes('collection:read');
  const assignment = actor.kind === 'account' && actor.requestedBy !== null;
  const native = (
    operation: Parameters<typeof accessNativeDeclaration>[0],
    shape: Parameters<typeof accessNativeDeclaration>[2],
    inputBytes: number,
  ) => {
    const value = accessNativeDeclaration(operation, {}, shape).bound;
    return Object.freeze({ ...value, bytes: value.bytes + inputBytes });
  };
  const formula = (action: string, publicFloor: boolean) => {
    const catalogue = resolveResourceRoles(new Map([...actions, [action, { anonymous: publicFloor }]]), resourceRoles);
    const grants = [...catalogue.roles].filter(([, values]) => values.includes(action)).map(([role]) => role);
    return native(
      'formula',
      {
        targets: 1,
        members,
        roles,
        grantRoles: grants.length,
        explicit: scope,
        public: publicFloor,
        global: true,
        assignment,
      },
      // Every native role row contains two UUIDs, closed kind/role/boolean fields
      // and a bounded current/next tstzrange. 512 covers its JSON representation;
      // identifiers/instants/scalars and the actual installed grant catalogue follow.
      roles * 512 + 4096 + Buffer.byteLength(JSON.stringify(grants)),
    );
  };
  const values = [
    native('time', {}, 128),
    native('opening-partition', {}, 128),
    native('opening', {}, 256),
    native('transaction', {}, 256),
    native('transaction', {}, 256),
    native('transaction', {}, 256),
    // The two explicit gate/exposure checkouts. The four implicit preparation
    // checkouts are Source overhead, not charged through Access a second time.
    { ...EMPTY_ACCESS_WORK, points: 2 },
    formula('collection:read', actions.get('collection:read')!.anonymous),
    formula('gate:collections', false),
    formula('gate:any', false),
  ];
  if (members) values.push(native('inverse', { members, groups: MEMBERSHIP_LIMIT }, members * 128));
  if (groups) values.push(native('membership', { groups }, groups * 128 + 256));
  if (assignment) values.push(native('assignment', {}, 512));
  return { access: addAccessWork(...values), overhead };
}

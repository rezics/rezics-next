import type { PoolClient } from 'pg';
import { resourceRoleHeld } from '../access/index.ts';
import { authoritativeTimeValue, type AuthoritativeTime } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import readCandidate from './lifecycle-read-candidate.sql';
import readContext from './lifecycle-read-context.sql';

export type LifecycleTarget =
  | { kind: 'candidate'; subject: string; candidate: string }
  | { kind: 'context'; context: string };
export type LifecycleEvidence = {
  target: LifecycleTarget;
  owner: { kind: 'write_basis' | 'owner_grant'; accountId: string } | null;
  state: 'active' | 'deleted' | 'purged';
  deletedAt: string | null;
  purgeAfter: string | null;
  held: boolean;
};
type LifecycleInput = { target: LifecycleTarget; accountId: string; nativeT: AuthoritativeTime };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(value: object, expected: string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
function id(value: unknown): value is string {
  return typeof value === 'string' && routeOf(value) !== null;
}
function validInput(value: unknown): value is LifecycleInput {
  if (!record(value) || !keys(value, ['target', 'accountId', 'nativeT']) || !id(value.accountId)) return false;
  const target = value.target;
  if (!record(target)) return false;
  return target.kind === 'candidate'
    ? keys(target, ['kind', 'subject', 'candidate']) && id(target.subject) && id(target.candidate)
    : target.kind === 'context' && keys(target, ['kind', 'context']) && id(target.context);
}

/** Trusted metadata only. The caller owns authorization, native T and the read/command snapshot. */
export async function readSemanticLifecycle(
  client: Pick<PoolClient, 'query'>,
  input: LifecycleInput,
): Promise<LifecycleEvidence | null> {
  if (!validInput(input)) throw new TypeError('Invalid semantic lifecycle read input');
  // Validate the actual capability even for a locator that can be rejected without SQL.
  authoritativeTimeValue(input.nativeT);
  const { accountId, nativeT } = input;
  const target: LifecycleTarget =
    input.target.kind === 'candidate'
      ? { kind: 'candidate', subject: input.target.subject, candidate: input.target.candidate }
      : { kind: 'context', context: input.target.context };
  let owner: LifecycleEvidence['owner'] = null;
  if (target.kind === 'candidate') {
    const route = routeOf(target.subject)!;
    if (routeOf(target.candidate) !== route) return null;
    const row = await readCandidate.run(client, {
      route,
      subject_id: target.subject,
      candidate_id: target.candidate,
      partition_no: partitionOf(route),
      account_id: accountId,
    });
    if (!row) return null;
    if (row.account_id !== null) owner = { kind: 'write_basis', accountId };
  } else {
    const route = routeOf(target.context)!;
    const row = await readContext.run(client, { route, context_id: target.context });
    if (!row) return null;
    if (
      row.kind === 'community' &&
      (await resourceRoleHeld(client, {
        resource: { route, id: target.context },
        role: 'semantic.context.owner',
        accountId,
        at: nativeT,
      }))
    )
      owner = { kind: 'owner_grant', accountId };
  }
  return { target, owner, state: 'active', deletedAt: null, purgeAfter: null, held: false };
}

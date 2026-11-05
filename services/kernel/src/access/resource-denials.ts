import {
  authoritativeTimeValue,
  currentCommand,
  type AuthoritativeTime,
  type CommandTransaction,
} from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import type { Resource } from '../request/access.ts';
import { validResource } from './grant-command.ts';
import endStatement from './resource-denial-end.sql';
import recordStatement from './resource-denial-record.sql';

import { ResourceAccessWriteDeniedError } from './resource-access-errors.ts';
export { ResourceAccessWriteDeniedError } from './resource-access-errors.ts';

const denialReasons = new Set(['resource', 'suspension', 'realm_ban']);
const denialAction = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/;

export type ResourceDenialWrite = {
  resource: Resource;
  subjectId: string;
  subjectRole: '';
  action: string;
  reason: 'resource' | 'suspension' | 'realm_ban';
  at: AuthoritativeTime;
};

/** The caller's command must already be authorized on this resource. `at` is that attempt's T. */
export function requireResourceCommand(tx: CommandTransaction, resource: Resource, at?: AuthoritativeTime): string {
  let command;
  try {
    command = currentCommand(tx);
  } catch {
    throw new ResourceAccessWriteDeniedError();
  }
  const authorization = command.authorization;
  if (
    !authorization ||
    authorization.mode !== 'execute' ||
    !validResource(resource) ||
    authorization.resource.route !== resource.route ||
    authorization.resource.id !== resource.id ||
    (at !== undefined && at !== command.time)
  )
    throw new ResourceAccessWriteDeniedError();
  return authoritativeTimeValue(command.time);
}

function denialInput(input: ResourceDenialWrite) {
  if (
    input.subjectRole !== '' ||
    !denialReasons.has(input.reason) ||
    typeof input.action !== 'string' ||
    !denialAction.test(input.action) ||
    routeOf(input.subjectId) === null
  )
    throw new ResourceAccessWriteDeniedError();
  return {
    route: input.resource.route,
    resource_id: input.resource.id,
    subject_id: input.subjectId,
    subject_role: input.subjectRole,
    action: input.action,
    reason: input.reason,
  };
}

/** Opens `[T, infinity)` for one denial key. An interval already open at T is left unchanged. */
export async function recordResourceDenial(tx: CommandTransaction, input: ResourceDenialWrite): Promise<void> {
  const at = requireResourceCommand(tx, input.resource, input.at);
  const key = denialInput(input);
  const row = await recordStatement.run(tx, { ...key, at, transaction_id: Bun.randomUUIDv7() });
  if (row.outcome !== 'open' && row.outcome !== 'inserted') throw new ResourceAccessWriteDeniedError();
}

/** Closes the open denial at T. No open row is left unchanged. */
export async function endResourceDenial(tx: CommandTransaction, input: ResourceDenialWrite): Promise<void> {
  const at = requireResourceCommand(tx, input.resource, input.at);
  const key = denialInput(input);
  const row = await endStatement.run(tx, { ...key, at });
  if (row.outcome !== 'absent' && row.outcome !== 'closed') throw new ResourceAccessWriteDeniedError();
}

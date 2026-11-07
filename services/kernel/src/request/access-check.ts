/** Prepared access checks depend on the supplied evaluator, not native permission acquisition. */
import { commandTime } from '../command/command.ts';
import { accessRoot } from '../access/derived-access.ts';
import { AccessUnavailableError } from '../access/unavailable.ts';
import type {
  Access,
  Actor,
  Resource,
  AccessContext,
  AccessCheck,
  AccessExplicitCheck,
  PreparedAccessCheckInvocation,
  PreparedAccessCheckWork,
  PrepareReadDecisionsInput,
  ReadDecisions,
} from './access.ts';

type PreparedWorkFactory = (
  actor: Actor,
  action: string,
  resource: Resource,
  evidence: unknown,
  dispatch: (input: PreparedAccessCheckInvocation) => Promise<boolean>,
) => PreparedAccessCheckWork | undefined;
// The standalone native evaluator may install during cyclic module loading.
// A hoisted, lazily initialized registry retains that installation without a TDZ
// or a later module initializer replacing it.
var preparedWorkFactories: WeakMap<Access, PreparedWorkFactory> | undefined;
/** Installed only by the original native evaluator and its original wrapper. */
export function installPreparedAccessCheckWork(access: Access, factory: PreparedWorkFactory): void {
  (preparedWorkFactories ??= new WeakMap()).set(access, factory);
}
export function nativePreparedAccessCheckWork(
  access: Access,
  actor: Actor,
  action: string,
  resource: Resource,
  evidence: unknown,
  dispatch: (input: PreparedAccessCheckInvocation) => Promise<boolean>,
): PreparedAccessCheckWork | undefined {
  return preparedWorkFactories?.get(access)?.(actor, action, resource, evidence, dispatch);
}
export async function accessCheck(
  access: Access,
  actor: Actor,
  action: string,
  resource: Resource,
  context: AccessContext,
): Promise<AccessCheck> {
  const evidence = access.prepare ? await access.prepare(actor, action, resource, context) : null;
  const check: AccessCheck = (client, time = commandTime(client)) =>
    access.authorize(client, actor, action, resource, evidence, time);
  const work = nativePreparedAccessCheckWork(access, actor, action, resource, evidence, ({ client, time }) =>
    check(client, time),
  );
  return work ? Object.assign(check, { work }) : check;
}

/** Resolve the installed port through derived adapters; never infer explicit
 * authority from an adapter's ordinary boolean decision. */
export async function accessExplicitCheck(
  access: Access,
  actor: Actor,
  action: string,
  resource: Resource,
  context: AccessContext,
): Promise<AccessExplicitCheck> {
  const root = accessRoot(access);
  if (!root.authorizeExplicit) return async () => ({ allowed: false, explicit: false });
  const evidence = root.prepare ? await root.prepare(actor, action, resource, context) : null;
  return (client, time = commandTime(client)) =>
    root.authorizeExplicit!(client, actor, action, resource, evidence, time);
}

/** The installed root owns the sole batch read formula, including through adapters. */
export async function prepareReadDecisions(access: Access, input: PrepareReadDecisionsInput): Promise<ReadDecisions> {
  const root = accessRoot(access);
  if (!root.prepareReadDecisions) throw new AccessUnavailableError('overloaded');
  return root.prepareReadDecisions(input);
}

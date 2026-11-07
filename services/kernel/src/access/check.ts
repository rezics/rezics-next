import type {
  Access,
  AccessCheck,
  AccessClient,
  AccessContext,
  AccessExplicitCheck,
  ActionCatalogue,
  Actor,
  PrepareReadDecisionsInput,
  PreparedAccessCheckInvocation,
  PreparedAccessCheckWork,
  ReadDecisions,
  Resource,
  ResourcePage,
} from '../request/access.ts';
import { commandTime } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import { accessRoot } from './derived-access.ts';
import { AccessUnavailableError } from './unavailable.ts';
export { AuthenticationError } from './contract/authentication.ts';
export type * from '../request/access.ts';

/** Reject malformed pages synchronously, before any database or actor read. */
export function resourcePage(page: ResourcePage): ResourcePage {
  if (
    !page ||
    'authenticatedBenefit' in page ||
    !Number.isInteger(page.route) ||
    page.route < 0 ||
    page.route > 65535 ||
    typeof page.resourceType !== 'string' ||
    page.resourceType.length === 0 ||
    !Array.isArray(page.ids) ||
    page.ids.length < 1 ||
    page.ids.length > 100 ||
    page.ids.some((id) => typeof id !== 'string' || routeOf(id) !== page.route) ||
    new Set(page.ids).size !== page.ids.length
  )
    throw new RangeError('Invalid resource page');
  return Object.freeze({
    route: page.route,
    resourceType: page.resourceType,
    ids: Object.freeze([...page.ids].sort()),
  });
}

/** Validate the bounded catalogue before reading any authority dependency. */
export function validReadDecisionActions(input: PrepareReadDecisionsInput, catalogue: ActionCatalogue): boolean {
  if (!input.actions.size || [...input.actions].some((action) => !catalogue.has(action))) return false;
  if (!input.typeActions) return input.actions.size <= 64;
  if (!input.typeActions.size || input.typeActions.size > 100) return false;
  const union = new Set<string>();
  for (const [type, actions] of input.typeActions) {
    if (!type.length || !actions.size || actions.size > 64) return false;
    for (const action of actions) union.add(action);
  }
  return union.size === input.actions.size && [...union].every((action) => input.actions.has(action));
}

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

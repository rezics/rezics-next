import type { KernelClient } from '@rezics/client';
import type { Identity } from '../management/data';
import { routedId } from '../resource-access/data';

export type Action = 'suspend' | 'reinstate';
export type Intent = Readonly<{ accountId: string; action: Action; key: string; reason?: string }>;
export type Failure = 'denied' | 'signed-out' | 'missing' | 'unavailable' | 'pending';
export type Page =
  | { status: 'ready'; account: Identity; offered: Action[]; currentState: 'unavailable' }
  | { status: Failure };
export type Outcome =
  | { status: 'recorded'; receiptId: string; current: Page }
  | { status: 'uncertain'; current: Page }
  | { status: Failure | 'conflict' | 'refused'; current?: Page };

const operations = { suspend: 'account.suspend', reinstate: 'account.reinstate' } as const;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export function parseSelection(value: unknown): { accountId: string } {
  if (!object(value) || Object.keys(value).length !== 1 || !routedId(value.accountId))
    throw new Error('Invalid account selection');
  return { accountId: value.accountId };
}
export function parseIntent(value: unknown): Intent {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !['accountId', 'action', 'key', 'reason'].includes(key)) ||
    !routedId(value.accountId) ||
    (value.action !== 'suspend' && value.action !== 'reinstate') ||
    typeof value.key !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.key) ||
    (value.reason !== undefined &&
      (typeof value.reason !== 'string' || value.reason.length < 1 || value.reason.length > 2000))
  )
    throw new Error('Invalid account lifecycle command');
  return Object.freeze({
    accountId: value.accountId,
    action: value.action,
    key: value.key,
    ...(value.reason === undefined ? {} : { reason: value.reason as string }),
  });
}
function failure(status: number): Failure {
  if (status === 401) return 'signed-out';
  if (status === 403) return 'denied';
  if (status === 404) return 'missing';
  if (status === 202) return 'pending';
  return 'unavailable';
}

/** Only exact native advertisements participate; identity, URL selection and roles confer no authority. */
export async function loadLifecycle(client: KernelClient, authorization: string, accountId: string): Promise<Page> {
  try {
    const headers = { authorization };
    const target = await client.accounts({ accountId }).management.get({ headers });
    if (target.error || !target.data) return { status: failure(target.status) };
    if (target.data.account.id !== accountId) return { status: 'unavailable' };
    const capabilities = await client.viewerActions.post(
      { resources: [{ type: 'access.account', id: accountId }] },
      { headers },
    );
    if (capabilities.error || !capabilities.data) return { status: failure(capabilities.status) };
    const resource = capabilities.data.resources.find(
      (item) => item.type === 'access.account' && item.id === accountId,
    );
    // not_found here also covers fenced accounts; it is never a suspension-state observation.
    const offered: Action[] = [];
    if (resource && 'viewerActions' in resource)
      for (const action of ['suspend', 'reinstate'] as const)
        if (
          resource.viewerActions.some(
            (entry) => entry.action === `account:${action}` && entry.operations.includes(operations[action]),
          )
        )
          offered.push(action);
    // Management deliberately omits lifecycle state. Do not replace this with public identity.state.
    return { status: 'ready', account: target.data.account, offered, currentState: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

/** Real generated bindings rewrite /$suspend and /$reinstate to native :customMethods.
 * The client also carries the native session token into the bounded read after the write. */
export async function commandLifecycle(client: KernelClient, authorization: string, intent: Intent): Promise<Outcome> {
  const current = await loadLifecycle(client, authorization, intent.accountId);
  if (current.status !== 'ready') return { status: current.status, current };
  if (!current.offered.includes(intent.action)) return { status: 'unavailable', current };
  const body = intent.reason === undefined ? {} : { reason: intent.reason };
  const options = { headers: { authorization, 'idempotency-key': intent.key } };
  try {
    const target = client.accounts({ accountId: intent.accountId });
    const result =
      intent.action === 'suspend'
        ? await target.$suspend.post(body, options)
        : await target.$reinstate.post(body, options);
    // One real current read, never a scan or an unbounded poll. It cannot yet prove lifecycle completion.
    const readback = await loadLifecycle(client, authorization, intent.accountId);
    if (result.error || !result.data) {
      const problem: unknown = result.error?.value;
      // Only native explicit not_applied allows a fresh intent. An HTTP status alone proves no such thing.
      if (!object(problem) || problem.effect_status !== 'not_applied')
        return { status: 'uncertain', current: readback };
      return {
        status:
          result.status === 409
            ? 'conflict'
            : result.status === 400 || result.status === 422
              ? 'refused'
              : failure(result.status),
        current: readback,
      };
    }
    const value = 'suspension' in result.data ? result.data.suspension : result.data.reinstatement;
    if (
      value.accountId !== intent.accountId ||
      value.state !== (intent.action === 'suspend' ? 'suspended' : 'active') ||
      !routedId(value.receiptId) ||
      !/^[1-9][0-9]{0,18}$/.test(value.minimumAuthnEpoch)
    )
      return { status: 'uncertain', current: readback };
    // This is a command observation, NOT evidence of Auth cleanup or operator fanout completion.
    return { status: 'recorded', receiptId: value.receiptId, current: readback };
  } catch {
    return { status: 'uncertain', current: await loadLifecycle(client, authorization, intent.accountId) };
  }
}

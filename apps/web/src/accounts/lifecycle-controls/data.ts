import type { KernelClient } from '@rezics/client';
import type { Identity } from '../management/data';
import { routedId } from '../resource-access/data';
import { LIFECYCLE_WAIT_MS, readWithin } from './request';

type LifecycleReview = NonNullable<
  Awaited<ReturnType<ReturnType<KernelClient['accounts']>['lifecycleReview']['post']>>['data']
>;
type LifecycleOriginalResult = NonNullable<LifecycleReview['original']>;
type LifecycleEffects = Extract<LifecycleOriginalResult, { status: 'recorded' }>['effects'];

export type Action = 'suspend' | 'reinstate';
export type Intent = Readonly<{ accountId: string; action: Action; key: string; reason?: string }>;
export type Failure = 'denied' | 'signed-out' | 'missing' | 'unavailable' | 'pending';
export type Page =
  | {
      status: 'ready';
      account: Identity;
      offered: Action[];
      currentState: 'unavailable' | LifecycleReview['current']['state'];
      native?: LifecycleReview['current'];
      original?: LifecycleOriginalResult;
    }
  | { status: Failure };
export type Outcome =
  | { status: 'recorded'; receiptId: string; current: Page; effects?: LifecycleEffects }
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

/** Only this dedicated native port may advertise lifecycle commands. Public viewerActions is unrelated. */
export async function loadLifecycle(
  client: KernelClient,
  authorization: string,
  accountId: string,
  intent?: Intent,
  signal?: AbortSignal,
): Promise<Page> {
  if (!authorization.trim()) return { status: 'signed-out' };
  try {
    const body = intent
      ? {
          original: {
            operationId: operations[intent.action],
            key: intent.key,
            ...(intent.reason === undefined ? {} : { reason: intent.reason }),
          },
        }
      : {};
    const target = await readWithin(
      (signal) =>
        client.accounts({ accountId }).lifecycleReview.post(body, {
          headers: { authorization, 'cache-control': 'no-store' },
          fetch: { signal },
        }),
      signal,
      LIFECYCLE_WAIT_MS,
    );
    if (target.error || !target.data) return { status: failure(target.status) };
    if (target.data.account.id !== accountId) return { status: 'unavailable' };
    const offered: Action[] = [];
    for (const action of ['suspend', 'reinstate'] as const)
      if (
        target.data.actions.some(
          (entry) => entry.action === `account:${action}` && entry.operationId === operations[action],
        )
      )
        offered.push(action);
    return {
      status: 'ready',
      account: target.data.account,
      offered,
      currentState: target.data.current.state,
      native: target.data.current,
      ...(target.data.original ? { original: target.data.original } : {}),
    };
  } catch {
    return { status: 'unavailable' };
  }
}

/** Real generated bindings rewrite /$suspend and /$reinstate to native :customMethods.
 * The client also carries the native session token into the bounded read after the write. */
export async function commandLifecycle(
  client: KernelClient,
  authorization: string,
  intent: Intent,
  signal?: AbortSignal,
): Promise<Outcome> {
  const current = await loadLifecycle(client, authorization, intent.accountId, intent, signal);
  if (current.status !== 'ready') return { status: current.status, current };
  if (current.original?.status === 'recorded')
    return { status: 'recorded', receiptId: current.original.receiptId, effects: current.original.effects, current };
  if (!current.offered.includes(intent.action)) return { status: 'unavailable', current };
  const body = intent.reason === undefined ? {} : { reason: intent.reason };
  try {
    const target = client.accounts({ accountId: intent.accountId });
    const result = await readWithin(
      async (signal) => {
        const options = { headers: { authorization, 'idempotency-key': intent.key }, fetch: { signal } };
        return intent.action === 'suspend'
          ? target.$suspend.post(body, options)
          : target.$reinstate.post(body, options);
      },
      signal,
      LIFECYCLE_WAIT_MS,
    );
    // One real current read, never a scan or an unbounded poll. It cannot yet prove lifecycle completion.
    const readback = await loadLifecycle(client, authorization, intent.accountId, intent, signal);
    if (readback.status === 'ready' && readback.original?.status === 'recorded')
      return {
        status: 'recorded',
        receiptId: readback.original.receiptId,
        effects: readback.original.effects,
        current: readback,
      };
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
    const readback = await loadLifecycle(client, authorization, intent.accountId, intent, signal);
    if (readback.status === 'ready' && readback.original?.status === 'recorded')
      return {
        status: 'recorded',
        receiptId: readback.original.receiptId,
        effects: readback.original.effects,
        current: readback,
      };
    return { status: 'uncertain', current: readback };
  }
}

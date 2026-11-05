import type { KernelClient } from '@rezics/client';
import { withVerificationDeadline } from './deadline';
import { isPlatformClosedError } from '../kernel/platform-closed';
import type { AgentVerificationRequest } from '../settings/verification-core';

// The applicant form remains with Settings. These are the existing generated-client transports.
export { readVerification, requestVerification, withdrawVerification } from '../settings/verification-core';
export type { AgentVerificationRequest, VerificationInput } from '../settings/verification-core';

export type ReadState<T> = { state: 'ready'; value: T } | { state: 'denied' | 'preparing' | 'unavailable' | 'invalid' };
export type Identity = { id: string; name: string; handle: string | null };
export type ReviewRequest = {
  request: AgentVerificationRequest;
  account: Identity | null;
  subject: { id: string; name: string } | null;
};
export type ReviewPage = { requests: ReviewRequest[]; next: string | null };
export type Publication =
  | { state: 'verified'; subject: { id: string; label: string; type: string } }
  | { state: 'unverified' | 'unavailable' };
export type AccountPage = {
  account: Identity | null;
  latest: ReadState<AgentVerificationRequest | null>;
  publication: Publication;
  reviewer: boolean;
  operations: string[];
};
export type Operation = {
  action: 'approve' | 'reject' | 'withdraw' | 'release' | 'revoke';
  targetId: string;
  reason: string;
  key: string;
};
export type OperationResult =
  | { state: 'accepted'; request?: AgentVerificationRequest; reversal?: 'released' | 'revoked' }
  | { state: 'denied' | 'preparing' | 'conflict' | 'invalid' | 'unavailable' | 'uncertain' };

const operationIds = [
  'account.read_verification_request',
  'account.request_verification',
  'account.withdraw_verification',
  'account.release_verification',
  'account.revoke_verification',
  'verification_request.list_pending',
  'verification_request.approve',
  'verification_request.reject',
];
export const verificationPageSize = 20;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function failure(status: number, error: unknown): Exclude<ReadState<never>, { state: 'ready' }> {
  const value = record(error) && record(error.value) ? error.value : undefined;
  if (value?.code === 'platform_closed') return { state: 'preparing' };
  if (status === 401 || status === 403 || status === 404) return { state: 'denied' };
  if (status === 400 || status === 422) return { state: 'invalid' };
  return { state: 'unavailable' };
}
function caught(error: unknown): Exclude<ReadState<never>, { state: 'ready' }> {
  return { state: isPlatformClosedError(error) ? 'preparing' : 'unavailable' };
}

/** Discovery only offers controls; every read and command still checks current native authority. */
export async function readOperations(
  client: KernelClient,
  authorization: string,
  caller?: AbortSignal,
): Promise<ReadState<string[]>> {
  try {
    const result = await withVerificationDeadline(
      (signal) => client['openapi.json'].get({ headers: { authorization }, fetch: { signal } }),
      caller,
    );
    if (result.error || !result.data) return failure(result.status, result.error);
    return {
      state: 'ready',
      value: Object.values(result.data.paths).flatMap((path) =>
        Object.values(path).flatMap((operation) =>
          operation.operationId && operationIds.includes(operation.operationId) ? [operation.operationId] : [],
        ),
      ),
    };
  } catch (error) {
    return caught(error);
  }
}

export async function readPending(
  client: KernelClient,
  authorization: string,
  cursor?: string,
  caller?: AbortSignal,
): Promise<ReadState<ReviewPage>> {
  try {
    const result = await withVerificationDeadline(
      (signal) =>
        client['verification-requests'].get({
          headers: { authorization },
          fetch: { signal },
          query: { state: 'pending', limit: verificationPageSize, ...(cursor ? { cursor } : {}) },
        }),
      caller,
    );
    if (result.error || !result.data) return failure(result.status, result.error);
    const requests = result.data.verificationRequests;
    // Resolve only this bounded, authorized page. Failed summaries are references, never fabricated identities.
    const [accounts, subjects] = await Promise.all([
      requests.length
        ? readIdentities(
            client,
            authorization,
            requests.map((r) => r.accountId),
            caller,
          )
        : [],
      Promise.all(requests.map((request) => readSubject(client, authorization, request.catalogueSubjectId, caller))),
    ]);
    return {
      state: 'ready',
      value: {
        next: result.data.next,
        requests: requests.map((request, index) => ({
          request,
          account: accounts.find((account) => account.id === request.accountId) ?? null,
          subject: subjects[index] ?? null,
        })),
      },
    };
  } catch (error) {
    return caught(error);
  }
}

async function readIdentities(
  client: KernelClient,
  authorization: string,
  ids: string[],
  caller?: AbortSignal,
): Promise<Identity[]> {
  try {
    const result = await withVerificationDeadline(
      (signal) =>
        client.accounts.get({
          headers: { authorization },
          fetch: { signal },
          query: { ids: [...new Set(ids)].join(',') },
        }),
      caller,
    );
    return (result.data?.accounts ?? []).flatMap((account) =>
      account.state === 'deleted'
        ? []
        : [
            {
              id: account.id,
              name: account.displayName ?? account.handle ?? account.id,
              handle: account.handle,
            },
          ],
    );
  } catch {
    return [];
  }
}
async function readSubject(client: KernelClient, authorization: string, id: string, caller?: AbortSignal) {
  try {
    const result = await withVerificationDeadline(
      (signal) => client.subjects({ id }).get({ headers: { authorization }, fetch: { signal } }),
      caller,
    );
    const subject = result.data?.subject;
    return subject ? { id, name: Object.values(subject.labels)[0] ?? id } : null;
  } catch {
    return null;
  }
}

export async function readLatest(
  client: KernelClient,
  authorization: string,
  accountId: string,
  caller?: AbortSignal,
): Promise<ReadState<AgentVerificationRequest | null>> {
  try {
    const result = await withVerificationDeadline(
      (signal) => client.accounts({ accountId }).verification.get({ headers: { authorization }, fetch: { signal } }),
      caller,
    );
    return result.data && !result.error
      ? { state: 'ready', value: result.data.verificationRequest }
      : failure(result.status, result.error);
  } catch (error) {
    return caught(error);
  }
}

export async function readAccount(
  client: KernelClient,
  authorization: string,
  accountId: string,
  caller?: AbortSignal,
): Promise<AccountPage> {
  const [latest, identities, discovery] = await Promise.all([
    readLatest(client, authorization, accountId, caller),
    readIdentities(client, authorization, [accountId], caller),
    readOperations(client, authorization, caller),
  ]);
  const account = identities.find((identity) => identity.id === accountId) ?? null;
  const publicationRead = async (): Promise<Publication> => {
    if (account?.handle) {
      try {
        const handle = account.handle;
        const result = await withVerificationDeadline(
          (signal) => client.accounts.get({ headers: { authorization }, query: { handle }, fetch: { signal } }),
          caller,
        );
        const current = result.data?.accounts.find((identity) => identity.id === accountId);
        if (current && 'verified' in current) {
          if (current.verified && current.subject) return { state: 'verified', subject: current.subject };
          if (current.verified === false) return { state: 'unverified' };
        }
      } catch {
        /* An unreadable public identity is unknown, even if a request was approved. */
      }
    }
    return { state: 'unavailable' };
  };
  const reviewerRead = async () => {
    // The list is the existing governance read authority. Its evidence is discarded on the status page.
    if (discovery.state === 'ready' && discovery.value.includes('account.revoke_verification')) {
      try {
        const result = await withVerificationDeadline(
          (signal) =>
            client['verification-requests'].get({
              headers: { authorization },
              fetch: { signal },
              query: { state: 'pending', limit: 1 },
            }),
          caller,
        );
        return !result.error && !!result.data;
      } catch {
        /* A failed current authority read never grants a control. */
      }
    }
    return false;
  };
  const [publication, reviewer] = await Promise.all([publicationRead(), reviewerRead()]);
  return { account, latest, publication, reviewer, operations: discovery.state === 'ready' ? discovery.value : [] };
}

export function validOperation(value: unknown): value is Operation {
  if (!record(value) || Object.keys(value).some((key) => !['action', 'targetId', 'reason', 'key'].includes(key)))
    return false;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return (
    typeof value.action === 'string' &&
    ['approve', 'reject', 'withdraw', 'release', 'revoke'].includes(value.action) &&
    typeof value.targetId === 'string' &&
    uuid.test(value.targetId) &&
    typeof value.reason === 'string' &&
    Array.from(value.reason).length <= 500 &&
    (!['withdraw', 'release'].includes(value.action) || value.reason === '') &&
    typeof value.key === 'string' &&
    uuid.test(value.key)
  );
}

/** Original request/account ids and key are sent unchanged, including after a lost response. */
export async function performOperation(
  client: KernelClient,
  authorization: string,
  operation: Operation,
  caller?: AbortSignal,
): Promise<OperationResult> {
  if (!validOperation(operation)) return { state: 'invalid' };
  const { action, targetId, reason, key } = operation;
  try {
    const account = client.accounts({ accountId: targetId });
    const request = client['verification-requests']({ requestId: targetId });
    const body = reason ? { reason } : {};
    const result = await withVerificationDeadline(async (signal) => {
      const options = { headers: { authorization, 'idempotency-key': key }, fetch: { signal } };
      return action === 'approve'
        ? request.$approve.post(body, options)
        : action === 'reject'
          ? request.$reject.post(body, options)
          : action === 'withdraw'
            ? account.$withdrawVerification.post({}, options)
            : action === 'revoke'
              ? account.$revokeVerification.post(body, options)
              : account.$releaseVerification.post({}, options);
    }, caller);
    if (!result.error && result.status === 200 && result.data) {
      if ('verificationRequest' in result.data) return { state: 'accepted', request: result.data.verificationRequest };
      if ('reversal' in result.data) return { state: 'accepted', reversal: result.data.reversal.kind };
    }
    if (result.status >= 500 || result.status === 0 || (!result.error && result.status === 200))
      return { state: 'uncertain' };
    if (result.status === 409) return { state: 'conflict' };
    return failure(result.status, result.error);
  } catch (error) {
    return { state: isPlatformClosedError(error) ? 'preparing' : 'uncertain' };
  }
}

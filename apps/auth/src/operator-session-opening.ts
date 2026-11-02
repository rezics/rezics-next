import { createServerFn } from '@tanstack/react-start';
import {
  isManagementOperation,
  managementOperationProfile,
  type ManagementOperationInput,
  type SessionProof,
} from '@rezics/auth-contract';
import { authPost } from './api';
import { approveManagementOperation } from './management-operations';
import { markManagementOpeningSubmitted } from './management-operation-step-up';

export type OpeningInput = ManagementOperationInput & {
  operation: { kind: 'opening'; operatorAccountId: string; subjectAccountId: string };
};
export type OpeningIdentity = {
  id: string;
  kind: 'actor' | 'organization' | null;
  handle: string | null;
  displayName: string | null;
};
export type OpeningMetadata = { subject: OpeningIdentity; operator: OpeningIdentity };
export type OpeningOutcome =
  | { kind: 'opened'; session: SessionProof }
  | { kind: 'refused' | 'step-up' | 'unavailable' | 'unknown' };
export type OpeningRead = { kind: 'ready'; metadata: OpeningMetadata } | { kind: 'unavailable' };
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: Record<string, unknown>, names: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...names].sort().join(',');
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096;
}
function id(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.exec(value)?.[0] === value;
}
function identity(value: unknown): value is OpeningIdentity {
  return (
    record(value) &&
    fields(value, ['id', 'kind', 'handle', 'displayName']) &&
    id(value.id) &&
    (value.kind === 'actor' || value.kind === 'organization') &&
    (value.handle === null || typeof value.handle === 'string') &&
    (value.displayName === null || typeof value.displayName === 'string')
  );
}
export function isOpeningInput(value: unknown): value is OpeningInput {
  return (
    record(value) &&
    fields(value, ['accountId', 'operationKey', 'operation']) &&
    id(value.accountId) &&
    text(value.operationKey) &&
    isManagementOperation(value.operation) &&
    value.operation.kind === 'opening' &&
    id(value.operation.operatorAccountId) &&
    id(value.operation.subjectAccountId)
  );
}
/** The native management point read already enforces active account, disclosure
 * and current operator management. Its real relation distinguishes an operated
 * actor from a human; URL IDs, self/role names and public profiles do not. */
export function parseOpeningMetadata(value: unknown, input: OpeningInput): OpeningRead {
  if (
    !record(value) ||
    !fields(value, ['account', 'self', 'role', 'operator', 'relation', 'members', 'responsibilities']) ||
    !identity(value.account) ||
    value.account.kind !== 'actor' ||
    value.account.id !== input.operation.subjectAccountId ||
    !identity(value.operator) ||
    value.operator.id !== input.operation.operatorAccountId ||
    !record(value.relation) ||
    !fields(value.relation, ['operatorAccountId', 'reservationId', 'version']) ||
    value.relation.operatorAccountId !== value.operator.id ||
    !id(value.relation.reservationId) ||
    typeof value.relation.version !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value.relation.version)
  )
    return { kind: 'unavailable' };
  return { kind: 'ready', metadata: { subject: { ...value.account }, operator: { ...value.operator } } };
}
/** The delivered private relation source and authorized identity projection must
 * describe the same native tuple. Neither observation supplies opening approval. */
export function parseOpeningSource(value: unknown, relation: unknown, input: OpeningInput): OpeningRead {
  const metadata = parseOpeningMetadata(value, input);
  if (
    metadata.kind !== 'ready' ||
    !record(value) ||
    !record(value.relation) ||
    !record(relation) ||
    !fields(relation, ['previous', 'expectedVersion']) ||
    !record(relation.previous) ||
    !fields(relation.previous, ['operatorAccountId', 'subjectAccountId', 'reservationId']) ||
    relation.previous.subjectAccountId !== input.operation.subjectAccountId ||
    relation.previous.operatorAccountId !== input.operation.operatorAccountId ||
    relation.previous.reservationId !== value.relation.reservationId ||
    relation.expectedVersion !== value.relation.version
  )
    return { kind: 'unavailable' };
  return metadata;
}
/** Native source IDs suffice for confirmation. It verifies the operated actor;
 * it does not disclose the operator's kind, handle or display name. */
export function parseOpeningRelation(value: unknown, input: OpeningInput): OpeningRead {
  if (
    !record(value) ||
    !fields(value, ['previous', 'expectedVersion']) ||
    !record(value.previous) ||
    !fields(value.previous, ['operatorAccountId', 'subjectAccountId', 'reservationId']) ||
    value.previous.subjectAccountId !== input.operation.subjectAccountId ||
    value.previous.operatorAccountId !== input.operation.operatorAccountId ||
    !id(value.previous.reservationId) ||
    typeof value.expectedVersion !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value.expectedVersion)
  )
    return { kind: 'unavailable' };
  return {
    kind: 'ready',
    metadata: {
      subject: { id: value.previous.subjectAccountId, kind: 'actor', handle: null, displayName: null },
      operator: { id: value.previous.operatorAccountId, kind: null, handle: null, displayName: null },
    },
  };
}
const nativeMetadata = createServerFn({ method: 'POST' })
  .validator((value: unknown): OpeningInput => {
    if (!isOpeningInput(value)) throw new Error('Invalid opening');
    return value;
  })
  .handler(async ({ data }): Promise<OpeningRead> => {
    const { getRequest, setResponseHeader } = await import('@tanstack/react-start/server');
    setResponseHeader('Cache-Control', 'private, no-store');
    let source: OpeningRead = { kind: 'unavailable' };
    try {
      const request = getRequest();
      const origin = new URL(request.url).origin;
      const issuer = import.meta.env.DEV && __AUTH_ORIGIN__ ? new URL(__AUTH_ORIGIN__).origin : origin;
      if (
        request.headers.get('sec-fetch-site') === 'cross-site' ||
        (request.headers.get('origin') !== origin && request.headers.get('origin') !== issuer)
      )
        return { kind: 'unavailable' };
      const headers = {
        Accept: 'application/json',
        Origin: request.headers.get('origin')!,
        Cookie: request.headers.get('cookie') ?? '',
      };
      const response = await fetch(new URL('/session', issuer), {
        headers,
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
      if (response.status !== 200) return { kind: 'unavailable' };
      const human: unknown = await response.json();
      const profile = managementOperationProfile('opening');
      if (
        !record(human) ||
        human.account_id !== data.accountId ||
        human.client_id !== profile.client_id ||
        !Array.isArray(human.scope) ||
        human.scope.length !== 1 ||
        human.scope[0] !== profile.scope[0] ||
        !Array.isArray(human.amr) ||
        human.amr.length !== 1 ||
        !['pwd', 'pop'].includes(human.amr[0])
      )
        return { kind: 'unavailable' };
      const relation = await fetch(new URL('/account-management/operators/relation', issuer), {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ subjectAccountId: data.operation.subjectAccountId }),
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
      if (relation.status !== 200) return { kind: 'unavailable' };
      const tuple: unknown = await relation.json();
      source = parseOpeningRelation(tuple, data);
      if (source.kind !== 'ready') return source;
      // Names are optional enrichment, never a reason to widen the selected
      // account:manage profile to account:read. With no authorized projection,
      // show only the exact IDs disclosed by the native relation source.
      const { env } = await import('cloudflare:workers');
      const configured = (env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN;
      if (!configured) return source;
      const tokenResponse = await fetch(new URL('/token', issuer), {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: '{}',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
      if (tokenResponse.status !== 200) return source;
      const token: unknown = await tokenResponse.json();
      if (!record(token) || !text(token.access_token) || token.token_type !== 'Bearer') return source;
      const kernel = new URL(configured);
      if (
        kernel.username ||
        kernel.password ||
        kernel.search ||
        kernel.hash ||
        kernel.pathname !== '/' ||
        !(
          kernel.protocol === 'https:' ||
          (import.meta.env.DEV &&
            kernel.protocol === 'http:' &&
            ['localhost', '127.0.0.1', '[::1]'].includes(kernel.hostname))
        )
      )
        return source;
      const result = await fetch(new URL(`/v1/accounts/${data.operation.subjectAccountId}/management`, kernel), {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token.access_token}` },
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
      if (result.status !== 200) return source;
      return parseOpeningSource(await result.json(), tuple, data);
    } catch {
      return source;
    }
  });
export async function loadOpeningMetadata(input: OpeningInput): Promise<OpeningRead> {
  if (!isOpeningInput(input)) return { kind: 'unavailable' };
  try {
    return await nativeMetadata({ data: input });
  } catch {
    return { kind: 'unavailable' };
  }
}
/** Automated proofs are displayed separately and never fed to the human-only
 * loadManagementSession. Scopes are exactly the native receipt's bound scopes. */
export function openedSession(value: unknown, input: OpeningInput): SessionProof | null {
  if (
    !record(value) ||
    !fields(value, ['account_id', 'client_id', 'scope', 'authn_epoch', 'auth_time', 'amr']) ||
    value.account_id !== input.operation.subjectAccountId ||
    value.client_id !== managementOperationProfile('opening').client_id ||
    !Array.isArray(value.amr) ||
    value.amr.length !== 1 ||
    value.amr[0] !== 'operator' ||
    !Array.isArray(value.scope) ||
    !value.scope.every((scope) => typeof scope === 'string') ||
    !Number.isSafeInteger(value.authn_epoch) ||
    (value.authn_epoch as number) < 0 ||
    !Number.isSafeInteger(value.auth_time) ||
    (value.auth_time as number) < 0 ||
    (value.auth_time as number) > Math.floor(Date.now() / 1000)
  )
    return null;
  return value as unknown as SessionProof;
}
/** Read only: never renew cached metadata, replay issuance, restore a human
 * cookie, or treat readback as evidence that this request created the session. */
export async function readOpenedSession(input: OpeningInput): Promise<OpeningOutcome> {
  try {
    const response = await fetch('/session', {
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    const session = response.status === 200 ? openedSession(await response.json(), input) : null;
    return session ? { kind: 'opened', session } : { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' };
  }
}
/** Explicit second submit only. The approval reference exists solely in this
 * request stack. Unlike mutations, ambiguous issuance is never retried. */
export async function submitOperatorOpening(
  input: OpeningInput,
  isCurrent: () => boolean = () => true,
): Promise<OpeningOutcome> {
  if (!isOpeningInput(input)) return { kind: 'refused' };
  const approved = await approveManagementOperation(input, 'opening', isCurrent);
  if (!isCurrent()) return { kind: 'unavailable' };
  if (approved.kind !== 'approved') return approved;
  const snapshot = approved.input;
  if (!isOpeningInput(snapshot)) return { kind: 'refused' };
  if (!markManagementOpeningSubmitted(snapshot)) return { kind: 'unavailable' };
  const result = await authPost('/operator-sessions/open', { ...snapshot, reference: approved.reference });
  if (!result.ok) {
    if (
      [400, 401, 403, 409, 413, 415].includes(result.status) &&
      ['account_operation_denied', 'step_up_required'].includes(result.code)
    )
      return { kind: 'refused' };
    return { kind: 'unknown' };
  }
  const session = openedSession(result.body, snapshot);
  return session ? { kind: 'opened', session } : { kind: 'unknown' };
}

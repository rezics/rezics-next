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
type LegacyOpeningIdentity = {
  id: string;
  kind: 'actor' | 'organization' | null;
  handle: string | null;
  displayName: string | null;
};
type LegacyOpeningMetadata = { subject: LegacyOpeningIdentity; operator: LegacyOpeningIdentity };
type LegacyOpeningRead = { kind: 'ready'; metadata: LegacyOpeningMetadata } | { kind: 'unavailable' };
export type OpeningIdentity = { id: string; kind: 'actor' | 'organization'; publicLabel: null };
export type OpeningMetadata = {
  viewer: { accountId: string; publicLabel: null };
  subject: OpeningIdentity;
  operator: OpeningIdentity;
  relation: { reservationId: string; version: string };
};
export type OpeningOutcome =
  | { kind: 'opened'; session: SessionProof }
  | { kind: 'refused' | 'step-up' | 'unavailable' | 'unknown' };
export type OpeningRead =
  | { kind: 'ready'; metadata: OpeningMetadata }
  | { kind: 'refused' | 'step-up' | 'unavailable' };
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
function identity(value: unknown): value is LegacyOpeningIdentity {
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
export function parseOpeningMetadata(value: unknown, input: OpeningInput): LegacyOpeningRead {
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
export function parseOpeningSource(value: unknown, relation: unknown, input: OpeningInput): LegacyOpeningRead {
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
export function parseOpeningRelation(value: unknown, input: OpeningInput): LegacyOpeningRead {
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
function openingPageIdentity(value: unknown, kind: 'actor' | 'organization'): value is { id: string; kind: string } {
  return record(value) && fields(value, ['id', 'kind']) && id(value.id) && value.kind === kind;
}
/** The native page observation is closed and advice-only. No private identifier
 * is reused as a public identity label when native disclosure is unavailable. */
export function parseOperatorOpeningPage(value: unknown, input: OpeningInput): OpeningRead {
  if (
    !record(value) ||
    !fields(value, ['stage', 'viewer', 'subject', 'operator', 'relation', 'disclosure', 'allowedActions']) ||
    value.stage !== 'current' ||
    !record(value.viewer) ||
    !fields(value.viewer, ['accountId']) ||
    !id(value.viewer.accountId) ||
    value.viewer.accountId !== input.accountId ||
    !openingPageIdentity(value.subject, 'actor') ||
    value.subject.id !== input.operation.subjectAccountId ||
    !record(value.operator) ||
    !fields(value.operator, ['id', 'kind']) ||
    !id(value.operator.id) ||
    value.operator.id !== input.operation.operatorAccountId ||
    (value.operator.kind !== 'actor' && value.operator.kind !== 'organization') ||
    !record(value.relation) ||
    !fields(value.relation, ['reservationId', 'version']) ||
    !id(value.relation.reservationId) ||
    typeof value.relation.version !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value.relation.version) ||
    value.disclosure !== 'unavailable' ||
    !Array.isArray(value.allowedActions) ||
    value.allowedActions.length !== 1 ||
    value.allowedActions[0] !== 'opening'
  )
    return { kind: 'unavailable' };
  return {
    kind: 'ready',
    metadata: {
      viewer: { accountId: value.viewer.accountId, publicLabel: null },
      subject: { id: value.subject.id, kind: 'actor', publicLabel: null },
      operator: { id: value.operator.id, kind: value.operator.kind, publicLabel: null },
      relation: { reservationId: value.relation.reservationId, version: value.relation.version },
    },
  };
}

export function sameOpeningPage(left: OpeningMetadata, right: OpeningMetadata): boolean {
  return (
    left.viewer.accountId === right.viewer.accountId &&
    left.subject.id === right.subject.id &&
    left.subject.kind === right.subject.kind &&
    left.operator.id === right.operator.id &&
    left.operator.kind === right.operator.kind &&
    left.relation.reservationId === right.relation.reservationId &&
    left.relation.version === right.relation.version
  );
}

export async function requestOperatorOpeningPage(
  input: OpeningInput,
  request: Request,
  issuer: string,
): Promise<OpeningRead> {
  try {
    const origin = new URL(request.url).origin;
    if (
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.headers.get('origin') !== origin && request.headers.get('origin') !== issuer)
    )
      return { kind: 'unavailable' };
    const response = await fetch(new URL('/account-management/operators/opening-page', issuer), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: issuer,
        Cookie: request.headers.get('cookie') ?? '',
      },
      body: JSON.stringify({
        subjectAccountId: input.operation.subjectAccountId,
        operatorAccountId: input.operation.operatorAccountId,
      }),
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    const body: unknown = await response.json();
    if (response.status === 200) return parseOperatorOpeningPage(body, input);
    if (response.status === 401 && record(body) && fields(body, ['stage']) && body.stage === 'step-up')
      return { kind: 'step-up' };
    if (
      [400, 403].includes(response.status) &&
      record(body) &&
      fields(body, ['stage']) &&
      body.stage === 'refused'
    )
      return { kind: 'refused' };
    return { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

const nativeOpeningPage = createServerFn({ method: 'POST' })
  .validator((value: unknown): OpeningInput => {
    if (!isOpeningInput(value)) throw new Error('Invalid opening');
    return value;
  })
  .handler(async ({ data }): Promise<OpeningRead> => {
    const { getRequest, setResponseHeader } = await import('@tanstack/react-start/server');
    setResponseHeader('Cache-Control', 'private, no-store');
    try {
      const request = getRequest();
      const origin = new URL(request.url).origin;
      const issuer = import.meta.env.DEV && __AUTH_ORIGIN__ ? new URL(__AUTH_ORIGIN__).origin : origin;
      return await requestOperatorOpeningPage(data, request, issuer);
    } catch {
      return { kind: 'unavailable' };
    }
  });
export async function loadOpeningMetadata(input: OpeningInput): Promise<OpeningRead> {
  if (!isOpeningInput(input)) return { kind: 'unavailable' };
  try {
    return await nativeOpeningPage({ data: input });
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

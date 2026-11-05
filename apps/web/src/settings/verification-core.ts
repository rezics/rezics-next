import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { MediaProblem } from '../media/kernel';
import { m } from '../paraglide/messages.js';
import { validateVerificationDraft } from './verification-validation';
import { settingsCommandKeyHeader } from './command-headers';
import { withVerificationDeadline } from './verification-request-deadline';

export type VerificationInput = {
  subject: string;
  statement: string;
  links: { label: string; url: string }[];
  idempotencyKey: string;
};

type VerificationResponse = NonNullable<
  Awaited<ReturnType<ReturnType<KernelClient['accounts']>['verification']['get']>>['data']
>;
export type AgentVerificationRequest = NonNullable<VerificationResponse['verificationRequest']>;
export type AgentVerificationViewerAction = { action: string; operations: string[] };
export type VerificationStatus = {
  verificationRequest: AgentVerificationRequest | null;
  viewerActions: AgentVerificationViewerAction[];
};

export type VerificationFailure = {
  status: number;
  message: string;
  code?: string;
  retryable?: boolean;
  requestId?: string;
  retryAfter?: string;
};
export type VerificationCommandResult =
  | { ok: true; verificationRequest: AgentVerificationRequest }
  | ({ ok: false; outcome?: 'refused' } & VerificationFailure);

/** Explicit private transport envelope: server-function Error serialization drops custom properties. */
export type VerificationReadResult<T> = { ok: true; value: T } | { ok: false; failure: VerificationFailure };

export type VerificationSearchFailure = Omit<VerificationFailure, 'requestId'> & {
  kind: 'refused' | 'closed' | 'unavailable';
};
export type VerificationSearchResult<T> = { ok: true; value: T } | { ok: false; failure: VerificationSearchFailure };

export class VerificationReadError extends Error {
  constructor(readonly failure: VerificationFailure) {
    super(failure.message);
    this.name = 'VerificationReadError';
  }
}

/** Keep the existing snapshot-or-thrown-error read contract at the caller boundary. */
export function unwrapVerificationRead<T>(result: VerificationReadResult<T>): T {
  if (!result.ok) throw new VerificationReadError(result.failure);
  return result.value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Native account response validation; an absent or malformed read is never a completed command. */
function validRequest(value: unknown, accountId: string): value is AgentVerificationRequest {
  if (!record(value)) return false;
  return (
    typeof value.id === 'string' &&
    !!value.id &&
    value.accountId === accountId &&
    (value.accountKind === 'actor' || value.accountKind === 'organization') &&
    (value.requestedBy === null || typeof value.requestedBy === 'string') &&
    typeof value.catalogueSubjectId === 'string' &&
    typeof value.statement === 'string' &&
    Array.isArray(value.links) &&
    value.links.length <= 5 &&
    value.links.every(
      (link: unknown) => record(link) && typeof link.label === 'string' && typeof link.url === 'string',
    ) &&
    typeof value.state === 'string' &&
    ['pending', 'approving', 'approved', 'rejected', 'withdrawn', 'failed'].includes(value.state) &&
    nullableString(value.reason) &&
    nullableString(value.decisionReceiptId) &&
    nullableString(value.decidedBy) &&
    (value.problem === null ||
      (record(value.problem) && typeof value.problem.type === 'string' && typeof value.problem.detail === 'string')) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  );
}

function validViewerAction(value: unknown): value is AgentVerificationViewerAction {
  if (!record(value) || !exactKeys(value, ['action', 'operations'])) return false;
  if (typeof value.action !== 'string' || !value.action) return false;
  if (!Array.isArray(value.operations) || value.operations.length < 1) return false;
  const operations = value.operations;
  if (operations.some((operation) => typeof operation !== 'string' || !operation)) return false;
  return new Set(operations).size === operations.length;
}

function validStatus(value: unknown, accountId: string): value is VerificationStatus {
  if (!record(value) || !exactKeys(value, ['verificationRequest', 'viewerActions'])) return false;
  if (value.verificationRequest !== null && !validRequest(value.verificationRequest, accountId)) return false;
  return Array.isArray(value.viewerActions) && value.viewerActions.every(validViewerAction);
}

function apiMessage(error: unknown): string {
  if (record(error) && record(error.value) && typeof error.value.detail === 'string') return error.value.detail;
  return m.settings_verification_request_failed();
}

function retryAfterHeader(headers: HeadersInit | undefined): string | undefined {
  if (headers === undefined) return undefined;
  try {
    const header = new Headers(headers).get('retry-after');
    return header !== null && header.length <= 128 ? header : undefined;
  } catch {
    return undefined;
  }
}

function nativeFailure(result: {
  status: number;
  error?: unknown;
  headers?: HeadersInit | undefined;
}): VerificationFailure {
  const problem = record(result.error) && record(result.error.value) ? result.error.value : undefined;
  const retryAfter = retryAfterHeader(result.headers);
  return {
    status: result.status,
    message: apiMessage(result.error),
    ...(typeof problem?.code === 'string' ? { code: problem.code } : {}),
    ...(typeof problem?.retryable === 'boolean' ? { retryable: problem.retryable } : {}),
    ...(typeof problem?.request_id === 'string'
      ? { requestId: problem.request_id }
      : typeof problem?.requestId === 'string'
        ? { requestId: problem.requestId }
        : {}),
    ...(retryAfter === undefined ? {} : { retryAfter }),
  };
}

/** Classified native/setup failures only; ordinary Errors and framework control flow stay undefined. */
export function verificationFailureFromException(
  error: unknown,
  fallbackMessage = m.settings_verification_request_failed(),
): VerificationFailure | undefined {
  if (error instanceof VerificationReadError) return error.failure;
  if (error instanceof MediaProblem)
    return nativeFailure({
      status: error.problem.status,
      error: { value: error.problem },
      headers: error.headers,
    });
  if (isPlatformClosedError(error))
    return nativeFailure({
      status: error.status,
      error: record(error.problem) ? { value: error.problem } : undefined,
    });
  if (error instanceof DOMException && error.name === 'TimeoutError') return { status: 0, message: fallbackMessage };
  return undefined;
}

/** Private current-read/command envelope used by the server functions; never leaks stacks or credentials. */
export function verificationSafeFailure(
  error: unknown,
  fallbackMessage = m.settings_verification_request_failed(),
): VerificationFailure {
  return verificationFailureFromException(error, fallbackMessage) ?? { status: 0, message: fallbackMessage };
}

function asReadError(error: unknown): VerificationReadError | undefined {
  if (error instanceof VerificationReadError) return error;
  const failure = verificationFailureFromException(error, m.settings_verification_load_failed());
  return failure ? new VerificationReadError(failure) : undefined;
}

export async function readVerification(
  client: KernelClient,
  accountId: string,
  authorization: string,
  caller?: AbortSignal,
) {
  try {
    const result = await withVerificationDeadline(
      (signal) => client.accounts({ accountId }).verification.get({ headers: { authorization }, fetch: { signal } }),
      caller,
    );
    if (result.error) throw new VerificationReadError(nativeFailure(result));
    const data: unknown = result.data;
    if (!validStatus(data, accountId))
      throw new VerificationReadError({
        status: result.status || 0,
        message:
          data == null ? m.settings_verification_request_failed() : m.settings_verification_load_failed(),
      });
    return data;
  } catch (error) {
    throw asReadError(error) ?? error;
  }
}

export async function requestVerification(
  client: KernelClient,
  accountId: string,
  authorization: string,
  input: VerificationInput,
  caller?: AbortSignal,
): Promise<VerificationCommandResult> {
  if (validateVerificationDraft(input).length)
    return { ok: false, status: 0, message: m.settings_verification_validation(), outcome: 'refused' };
  try {
    const result = await withVerificationDeadline(
      (signal) =>
        client.accounts({ accountId }).$requestVerification.post(
          { subject: input.subject, statement: input.statement, links: input.links },
          {
            headers: { authorization, 'idempotency-key': settingsCommandKeyHeader(input.idempotencyKey) } as {
              'idempotency-key': string;
            },
            fetch: { signal },
          },
        ),
      caller,
    );
    if (result.status === 201 && validRequest(result.data?.verificationRequest, accountId))
      return { ok: true, verificationRequest: result.data!.verificationRequest };
    return { ok: false, ...nativeFailure(result) };
  } catch (error) {
    const failure = verificationFailureFromException(error);
    if (failure) return { ok: false, ...failure };
    throw error;
  }
}

export async function withdrawVerification(
  client: KernelClient,
  accountId: string,
  authorization: string,
  idempotencyKey: string,
  caller?: AbortSignal,
): Promise<VerificationCommandResult> {
  try {
    const result = await withVerificationDeadline(
      (signal) =>
        client.accounts({ accountId }).$withdrawVerification.post(
          {},
          {
            headers: { authorization, 'idempotency-key': settingsCommandKeyHeader(idempotencyKey) } as {
              'idempotency-key': string;
            },
            fetch: { signal },
          },
        ),
      caller,
    );
    if (result.status === 200 && validRequest(result.data?.verificationRequest, accountId))
      return { ok: true, verificationRequest: result.data!.verificationRequest };
    return { ok: false, ...nativeFailure(result) };
  } catch (error) {
    const failure = verificationFailureFromException(error);
    if (failure) return { ok: false, ...failure };
    throw error;
  }
}

/** Optional display data has its own request, never part of authoritative review/readback. */
export async function readVerificationTitle(
  client: KernelClient,
  subjectId: string,
  authorization: string,
  languages: string[],
  caller?: AbortSignal,
): Promise<string | null> {
  try {
    return await withVerificationDeadline(async (signal) => {
      const subject = await client.subjects({ id: subjectId }).get({ headers: { authorization }, fetch: { signal } });
      const labels = subject.error ? undefined : subject.data?.subject?.labels;
      return labels
        ? (languages.map((language) => labels[language]).find((label) => label !== undefined) ??
            Object.values(labels)[0] ??
            null)
        : null;
    }, caller);
  } catch {
    return null;
  }
}

/** A fresh, caller-bound release read cannot inherit a stalled shared display-cache promise. */
export async function readVerificationEligibility(client: KernelClient, authorization: string, caller?: AbortSignal) {
  return withVerificationDeadline(async (signal) => {
    const options = { headers: { authorization }, fetch: { signal } };
    const active = await client.definitions.active.get(options);
    const digest = active.data?.digest;
    if (active.error || !digest) throw new Error('Eligibility unavailable');
    signal.throwIfAborted();
    const released = await client.definitions.releases({ digest }).get(options);
    if (released.error || released.data?.digest !== digest || !released.data.release)
      throw new Error('Eligibility unavailable');
    return released.data.release;
  }, caller);
}

import type { KernelClient } from '@rezics/client';
import { withVerificationDeadline } from './verification-request-deadline';
import { m } from '../paraglide/messages.js';
import { validateVerificationDraft } from './verification-validation';
import { settingsCommandKeyHeader } from './command-headers';

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

function apiMessage(error: unknown): string {
  if (record(error) && record(error.value) && typeof error.value.detail === 'string') return error.value.detail;
  return m.settings_verification_request_failed();
}

function nativeFailure(result: {
  status: number;
  error?: unknown;
  headers?: HeadersInit | undefined;
}): VerificationFailure {
  const problem = record(result.error) && record(result.error.value) ? result.error.value : undefined;
  const retryAfter = result.headers === undefined ? null : new Headers(result.headers).get('retry-after');
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
    ...(retryAfter === null ? {} : { retryAfter }),
  };
}

export async function readVerification(
  client: KernelClient,
  accountId: string,
  authorization: string,
  caller?: AbortSignal,
) {
  const result = await withVerificationDeadline(
    (signal) => client.accounts({ accountId }).verification.get({ headers: { authorization }, fetch: { signal } }),
    caller,
  );
  if (result.error) throw new VerificationReadError(nativeFailure(result));
  if (!result.data) throw new Error(m.settings_verification_request_failed());
  const request = result.data.verificationRequest;
  if (request !== null && !validRequest(request, accountId)) throw new Error(m.settings_verification_load_failed());
  return request;
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
}

export async function withdrawVerification(
  client: KernelClient,
  accountId: string,
  authorization: string,
  idempotencyKey: string,
  caller?: AbortSignal,
): Promise<VerificationCommandResult> {
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

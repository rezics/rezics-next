import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from './ports/vocabulary';
import { m } from '../paraglide/messages.js';
import { portableVerificationFailure, validateVerificationDraft } from './core/verification';
import { settingsCommandKeyHeader } from './command-headers';
import { serverSettingsTimer } from './adapters/ambient';
import { withVerificationDeadline } from './application/verification';
import type { SettingsContentFailureReader } from './ports/content';

import {
  VerificationReadError,
  type AgentVerificationRequest,
  type AgentVerificationViewerAction,
  type VerificationCommandResult,
  type VerificationFailure,
  type VerificationInput,
  type VerificationStatus,
} from './contract/verification';

export {
  unwrapVerificationRead,
  VerificationReadError,
  type AgentVerificationRequest,
  type AgentVerificationViewerAction,
  type VerificationCommandResult,
  type VerificationFailure,
  type VerificationInput,
  type VerificationReadResult,
  type VerificationSearchFailure,
  type VerificationSearchResult,
  type VerificationStatus,
} from './contract/verification';

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
  mediaFailure: SettingsContentFailureReader = () => undefined,
): VerificationFailure | undefined {
  const portable = portableVerificationFailure(error, fallbackMessage);
  if (portable) return portable;
  const contentFailure = mediaFailure(error);
  if (contentFailure)
    return nativeFailure({
      status: contentFailure.status,
      error: { value: contentFailure.problem },
      headers: contentFailure.headers,
    });
  if (isPlatformClosedError(error))
    return nativeFailure({
      status: error.status,
      error: record(error.problem) ? { value: error.problem } : undefined,
    });
  return undefined;
}

/** Private current-read/command envelope used by the server functions; never leaks stacks or credentials. */
export function verificationSafeFailure(
  error: unknown,
  fallbackMessage = m.settings_verification_request_failed(),
  mediaFailure: SettingsContentFailureReader = () => undefined,
): VerificationFailure {
  return (
    verificationFailureFromException(error, fallbackMessage, mediaFailure) ?? { status: 0, message: fallbackMessage }
  );
}

function asReadError(
  error: unknown,
  mediaFailure: SettingsContentFailureReader = () => undefined,
): VerificationReadError | undefined {
  if (error instanceof VerificationReadError) return error;
  const failure = verificationFailureFromException(error, m.settings_verification_load_failed(), mediaFailure);
  return failure ? new VerificationReadError(failure) : undefined;
}

export async function readVerification(
  client: KernelClient,
  accountId: string,
  authorization: string,
  caller?: AbortSignal,
  mediaFailure: SettingsContentFailureReader = () => undefined,
) {
  try {
    const result = await withVerificationDeadline(
      (signal) => client.accounts({ accountId }).verification.get({ headers: { authorization }, fetch: { signal } }),
      caller,
      serverSettingsTimer(),
    );
    if (result.error) throw new VerificationReadError(nativeFailure(result));
    const data: unknown = result.data;
    if (!validStatus(data, accountId))
      throw new VerificationReadError({
        status: result.status || 0,
        message: data == null ? m.settings_verification_request_failed() : m.settings_verification_load_failed(),
      });
    return data;
  } catch (error) {
    throw asReadError(error, mediaFailure) ?? error;
  }
}

export async function requestVerification(
  client: KernelClient,
  accountId: string,
  authorization: string,
  input: VerificationInput,
  caller?: AbortSignal,
  mediaFailure: SettingsContentFailureReader = () => undefined,
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
      serverSettingsTimer(),
    );
    if (result.status === 201 && validRequest(result.data?.verificationRequest, accountId))
      return { ok: true, verificationRequest: result.data!.verificationRequest };
    return { ok: false, ...nativeFailure(result) };
  } catch (error) {
    const failure = verificationFailureFromException(error, undefined, mediaFailure);
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
  mediaFailure: SettingsContentFailureReader = () => undefined,
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
      serverSettingsTimer(),
    );
    if (result.status === 200 && validRequest(result.data?.verificationRequest, accountId))
      return { ok: true, verificationRequest: result.data!.verificationRequest };
    return { ok: false, ...nativeFailure(result) };
  } catch (error) {
    const failure = verificationFailureFromException(error, undefined, mediaFailure);
    if (failure) return { ok: false, ...failure };
    throw error;
  }
}

export { readVerificationEligibility, readVerificationTitle } from './adapters/verification';
export { validateVerificationDraft } from './core/verification';

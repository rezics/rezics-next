import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError, isPlatformClosedProblem } from '../ports/vocabulary';
import { m } from '../../paraglide/messages.js';
import { settingsCommandKeyHeader } from '../command-headers';
import { createServerSettingsAmbient, serverSettingsTimer } from './ambient';
import { createVerificationApplication, withVerificationDeadline } from '../application/verification';
import type { VerificationAmbient } from '../contract/verification';
import {
  VERIFICATION_SUGGESTION_LIMIT,
  VerificationReadError,
  type AgentVerificationRequest,
  type AgentVerificationViewerAction,
  type VerificationCommandResult,
  type VerificationEligibleSearchCopy,
  type VerificationFailure,
  type VerificationInput,
  type VerificationOperations,
  type VerificationRelease,
  type VerificationSearchFailure,
  type VerificationStatus,
  type VerificationSuggestionHit,
} from '../contract/verification';
import { portableVerificationFailure, validateVerificationDraft } from '../core/verification';

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

function mediaTransportFault(error: unknown): { status: number; problem: Record<string, unknown>; headers?: HeadersInit } | undefined {
  if (!record(error) || !record(error.problem)) return;
  const status = error.problem.status;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) return;
  return {
    status,
    problem: error.problem,
    ...(error.headers === undefined ? {} : { headers: error.headers as HeadersInit }),
  };
}

/** Classified native/setup failures only; ordinary Errors and framework control flow stay undefined. */
export function verificationFailureFromException(
  error: unknown,
  fallbackMessage = m.settings_verification_request_failed(),
): VerificationFailure | undefined {
  const portable = portableVerificationFailure(error, fallbackMessage);
  if (portable) return portable;
  const media = mediaTransportFault(error);
  if (media)
    return nativeFailure({
      status: media.status,
      error: { value: media.problem },
      headers: media.headers,
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
): VerificationFailure {
  return verificationFailureFromException(error, fallbackMessage) ?? { status: 0, message: fallbackMessage };
}

function asReadError(error: unknown): VerificationReadError | undefined {
  if (error instanceof VerificationReadError) return error;
  const failure = verificationFailureFromException(error, m.settings_verification_load_failed());
  return failure ? new VerificationReadError(failure) : undefined;
}

function safeSearchCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value) ? value : undefined;
}

export function verificationSubjectSearchFailure(error: unknown): VerificationSearchFailure {
  const media = mediaTransportFault(error);
  let statusValue: unknown = media?.status;
  let problem: Record<string, unknown> | undefined = media?.problem;
  let retryAfter: string | undefined;
  if (media?.headers) {
    try {
      const header = new Headers(media.headers).get('retry-after');
      if (header !== null && header.length <= 128) retryAfter = header;
    } catch {
      // Malformed headers are not part of the private response contract.
    }
  } else if (isPlatformClosedError(error)) {
    statusValue = error.status;
    if (record(error.problem)) problem = error.problem;
  }
  const status =
    typeof statusValue === 'number' && Number.isInteger(statusValue) && statusValue >= 100 && statusValue <= 599
      ? statusValue
      : 0;
  const code = safeSearchCode(problem?.code);
  const closed = isPlatformClosedError(error) || isPlatformClosedProblem(status, problem);
  const kind = closed ? 'closed' : status >= 400 && status < 500 ? 'refused' : 'unavailable';
  const message =
    kind === 'closed'
      ? m.settings_verification_search_closed()
      : kind === 'refused'
        ? m.settings_verification_search_refused()
        : m.settings_verification_search_unavailable();
  return {
    kind,
    status,
    message,
    ...(code === undefined ? {} : { code }),
    ...(typeof problem?.retryable === 'boolean' ? { retryable: problem.retryable } : {}),
    ...(retryAfter === undefined ? {} : { retryAfter }),
  };
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
      serverSettingsTimer(),
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
      serverSettingsTimer(),
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
    return await withVerificationDeadline(
      async (signal) => {
        const subject = await client.subjects({ id: subjectId }).get({ headers: { authorization }, fetch: { signal } });
        const labels = subject.error ? undefined : subject.data?.subject?.labels;
        return labels
          ? (languages.map((language) => labels[language]).find((label) => label !== undefined) ??
              Object.values(labels)[0] ??
              null)
          : null;
      },
      caller,
      serverSettingsTimer(),
    );
  } catch {
    return null;
  }
}

/** A fresh, caller-bound release read cannot inherit a stalled shared display-cache promise. */
export async function readVerificationEligibility(
  client: KernelClient,
  authorization: string,
  caller?: AbortSignal,
): Promise<VerificationRelease> {
  return withVerificationDeadline(async (signal) => {
    const options = { headers: { authorization }, fetch: { signal } };
    const active = await client.definitions.active.get(options);
    const digest = active.data?.digest;
    if (active.error || !digest) throw new Error('Eligibility unavailable');
    signal.throwIfAborted();
    const released = await client.definitions.releases({ digest }).get(options);
    const release = released.data?.release;
    if (released.error || released.data?.digest !== digest || !record(release) || !record(release.types))
      throw new Error('Eligibility unavailable');
    return { types: release.types as VerificationRelease['types'] };
  }, caller, serverSettingsTimer());
}

function admittedSuggestionHits(value: unknown): VerificationSuggestionHit[] {
  if (!record(value) || !Array.isArray(value.subjects)) throw new TypeError('Malformed suggestion page');
  return value.subjects.map((subject) => {
    if (!record(subject) || typeof subject.id !== 'string' || typeof subject.type !== 'string' || !record(subject.labels))
      throw new TypeError('Malformed suggestion page');
    const labels: Record<string, string> = {};
    for (const [language, label] of Object.entries(subject.labels)) {
      if (typeof label !== 'string') throw new TypeError('Malformed suggestion page');
      labels[language] = label;
    }
    const summary = subject.summary;
    if (summary !== null && summary !== undefined && !record(summary)) throw new TypeError('Malformed suggestion page');
    const rawLabel = summary && record(summary.label) ? summary.label : null;
    const label =
      rawLabel && typeof rawLabel.value === 'string'
        ? {
            value: rawLabel.value,
            ...(typeof rawLabel.language === 'string' ? { language: rawLabel.language } : {}),
          }
        : null;
    return {
      id: subject.id,
      type: subject.type,
      labels,
      summary: summary === null || summary === undefined ? null : { label },
    };
  });
}

export async function suggestVerificationSubjects(
  client: KernelClient,
  query: string,
  languages: string[],
  authorization: string,
  caller?: AbortSignal,
): Promise<VerificationSuggestionHit[]> {
  const result = await client.subjects.$suggest.get({
    query: { q: query, limit: VERIFICATION_SUGGESTION_LIMIT, languages },
    headers: { authorization },
    ...(caller ? { fetch: { signal: caller } } : {}),
  });
  if (result.error) {
    const failure = nativeFailure(result);
    const error = new Error(failure.message) as Error & { status?: number; problem?: Record<string, unknown>; headers?: HeadersInit };
    error.status = failure.status;
    if (failure.code) error.problem = { status: failure.status, code: failure.code };
    if (failure.retryAfter) error.headers = { 'retry-after': failure.retryAfter };
    throw error;
  }
  return admittedSuggestionHits(result.data).slice(0, VERIFICATION_SUGGESTION_LIMIT);
}

export function nativeVerificationCopy(): VerificationEligibleSearchCopy {
  return {
    person: m.settings_verification_person(),
    organization: m.settings_verification_organization(),
  };
}

export function nativeVerificationOperations(
  client: KernelClient,
  authorization: string,
  languages: string[],
): VerificationOperations {
  return {
    status: (accountId, signal) => readVerification(client, accountId, authorization, signal),
    request: (accountId, input, signal) => requestVerification(client, accountId, authorization, input, signal),
    withdraw: (accountId, idempotencyKey, signal) =>
      withdrawVerification(client, accountId, authorization, idempotencyKey, signal),
    eligibility: (signal) => readVerificationEligibility(client, authorization, signal),
    title: (subjectId, requestedLanguages, signal) =>
      readVerificationTitle(client, subjectId, authorization, requestedLanguages, signal),
    suggest: (query, requestedLanguages, signal) =>
      suggestVerificationSubjects(client, query, requestedLanguages ?? languages, authorization, signal),
  };
}

export function bindVerificationApplication(
  client: KernelClient,
  authorization: string,
  languages: string[],
  ambient: VerificationAmbient = createServerSettingsAmbient(),
) {
  return createVerificationApplication(
    nativeVerificationOperations(client, authorization, languages),
    nativeVerificationCopy(),
    ambient,
  );
}

export { unwrapVerificationRead, VerificationReadError } from '../contract/verification';

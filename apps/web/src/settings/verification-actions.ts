import { serverSettingsTimer } from './adapters/ambient';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../kernel/client';
import { requestLanguages } from './ports/vocabulary';
import { m } from '../paraglide/messages.js';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { searchEligibleVerificationSubjects, withVerificationDeadline } from './application/verification';
import {
  bindVerificationApplication,
  nativeVerificationCopy,
  nativeVerificationOperations,
  verificationSafeFailure,
  verificationSubjectSearchFailure,
} from './adapters/verification';
import { truncateVerificationQuery, validateVerificationDraft } from './core/verification';
import type { VerificationFailure, VerificationInput } from './contract/verification';

function uuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function parseInput(input: unknown): VerificationInput | undefined {
  if (!input || typeof input !== 'object') return;
  const value = input as Record<string, unknown>;
  if (
    typeof value.subject !== 'string' ||
    typeof value.statement !== 'string' ||
    !Array.isArray(value.links) ||
    value.links.length > 5 ||
    !uuid(value.idempotencyKey)
  )
    return;
  const links: { label: string; url: string }[] = [];
  for (const link of value.links) {
    if (!link || typeof link !== 'object') return;
    const candidate = link as Record<string, unknown>;
    if (typeof candidate.label !== 'string' || typeof candidate.url !== 'string') return;
    links.push({ label: candidate.label, url: candidate.url });
  }
  const parsed = {
    subject: value.subject,
    statement: value.statement,
    links,
    idempotencyKey: value.idempotencyKey,
  };
  return validateVerificationDraft(parsed).length ? undefined : parsed;
}

function expectedAccount(input: unknown): string {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof (input as { accountId?: unknown }).accountId !== 'string' ||
    !(input as { accountId: string }).accountId
  )
    throw new Error('Invalid verification account');
  return (input as { accountId: string }).accountId;
}

async function viewer() {
  const request = getRequest();
  await withVerificationDeadline(
    () => prepareSession(request, env as Partial<SessionEnv>),
    request.signal,
    serverSettingsTimer(),
  );
  const authorization = viewerCredential(request);
  const accountId = sessionSubject(request);
  if (!authorization || !accountId) throw new Error('Sign in is required');
  return { request, authorization, accountId };
}

function currentReadFailure(error: unknown): VerificationFailure {
  return verificationSafeFailure(error, m.settings_verification_load_failed());
}

function commandFailure(error: unknown) {
  return { ok: false as const, ...verificationSafeFailure(error) };
}

export const readVerificationState = createServerFn({ method: 'GET' })
  .validator(expectedAccount)
  .handler(async ({ data: expectedAccountId }) => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      const { request, authorization, accountId } = await viewer();
      if (accountId !== expectedAccountId)
        return { ok: false as const, failure: { status: 409, message: m.settings_verification_identity_changed() } };
      const application = bindVerificationApplication(
        kernelClient(),
        authorization,
        requestLanguages(requestLocale(request) ?? 'en'),
      );
      const status = await application.status(accountId, request.signal);
      return { ok: true as const, value: { accountId, ...status, subjectTitle: null } };
    } catch (error) {
      return { ok: false as const, failure: currentReadFailure(error) };
    }
  });

export const readVerificationSubjectTitle = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const accountId = expectedAccount(input);
    const subjectId = (input as { subjectId?: unknown }).subjectId;
    if (typeof subjectId !== 'string' || !subjectId || subjectId.length > 256)
      throw new Error('Invalid verification subject');
    return { accountId, subjectId };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      const { request, authorization, accountId } = await viewer();
      if (accountId !== data.accountId) return null;
      const application = bindVerificationApplication(
        kernelClient(),
        authorization,
        requestLanguages(requestLocale(request) ?? 'en'),
      );
      return application.title(data.subjectId, requestLanguages(requestLocale(request) ?? 'en'), request.signal);
    } catch {
      return null;
    }
  });

export const searchVerificationSubjects = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (!input || typeof input !== 'object' || typeof (input as { query?: unknown }).query !== 'string')
      throw new Error('Invalid query');
    return truncateVerificationQuery((input as { query: string }).query);
  })
  .handler(async ({ data: query }) => {
    setResponseHeader('cache-control', 'private, no-store');
    if (!query.trim()) return { ok: true as const, value: [] };
    try {
      const { request, authorization } = await viewer();
      const languages = requestLanguages(requestLocale(request) ?? 'en');
      const operations = nativeVerificationOperations(kernelClient(), authorization, languages);
      const value = await withVerificationDeadline(
        (signal) => searchEligibleVerificationSubjects(query, operations, nativeVerificationCopy(), languages, signal),
        request.signal,
        serverSettingsTimer(),
      );
      return { ok: true as const, value };
    } catch (error) {
      return { ok: false as const, failure: verificationSubjectSearchFailure(error) };
    }
  });

export const requestVerificationAction = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const parsed = parseInput(input);
    if (!parsed) throw new Error('Invalid verification request');
    return { ...parsed, accountId: expectedAccount(input) };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      const { request, authorization, accountId } = await viewer();
      if (accountId !== data.accountId)
        return { ok: false as const, status: 409, message: m.settings_verification_identity_changed() };
      const application = bindVerificationApplication(
        kernelClient(),
        authorization,
        requestLanguages(requestLocale(request) ?? 'en'),
      );
      return application.request(accountId, data, request.signal);
    } catch (error) {
      return commandFailure(error);
    }
  });

export const withdrawVerificationAction = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (!input || typeof input !== 'object' || !uuid((input as { idempotencyKey?: unknown }).idempotencyKey))
      throw new Error('Invalid verification withdrawal');
    return { idempotencyKey: (input as { idempotencyKey: string }).idempotencyKey, accountId: expectedAccount(input) };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      const { request, authorization, accountId } = await viewer();
      if (accountId !== data.accountId)
        return { ok: false as const, status: 409, message: m.settings_verification_identity_changed() };
      const application = bindVerificationApplication(
        kernelClient(),
        authorization,
        requestLanguages(requestLocale(request) ?? 'en'),
      );
      return application.withdraw(accountId, data.idempotencyKey, request.signal);
    } catch (error) {
      return commandFailure(error);
    }
  });

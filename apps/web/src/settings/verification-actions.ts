import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../kernel/client';
import { m } from '../paraglide/messages.js';
import { suggestSubjects } from '../search/suggestions';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { requestLanguages } from '../kernel/languages';
import { readRelease } from '../subject/definitions';
import type { VerificationInput } from './verification-core';

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
    !value.subject ||
    typeof value.statement !== 'string' ||
    !value.statement.trim() ||
    value.statement.length > 2000 ||
    !Array.isArray(value.links) ||
    value.links.length > 5 ||
    !uuid(value.idempotencyKey)
  )
    return;
  const links: { label: string; url: string }[] = [];
  for (const link of value.links) {
    if (!link || typeof link !== 'object') return;
    const candidate = link as Record<string, unknown>;
    if (
      typeof candidate.label !== 'string' ||
      !candidate.label.trim() ||
      typeof candidate.url !== 'string' ||
      !candidate.url.trim()
    )
      return;
    links.push({ label: candidate.label, url: candidate.url });
  }
  return {
    subject: value.subject,
    statement: value.statement,
    links,
    idempotencyKey: value.idempotencyKey,
  };
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
  await prepareSession(request, env as Partial<SessionEnv>);
  const authorization = viewerCredential(request);
  const accountId = sessionSubject(request);
  if (!authorization || !accountId) throw new Error('Sign in is required');
  return { request, authorization, accountId };
}

export const readVerificationState = createServerFn({ method: 'GET' })
  .validator(expectedAccount)
  .handler(async ({ data: expectedAccountId }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const { request, authorization, accountId } = await viewer();
    if (accountId !== expectedAccountId) throw new Error(m.settings_verification_identity_changed());
    const client = kernelClient();
    const { readVerification } = await import('./verification-core');
    const verificationRequest = await readVerification(client, accountId, authorization);
    if (!verificationRequest) return { accountId, verificationRequest: null, subjectTitle: null };
    const subject = await client
      .subjects({ id: verificationRequest.catalogueSubjectId })
      .get({ headers: { authorization } });
    const labels = subject.data?.subject?.labels;
    const languages = requestLanguages(requestLocale(request) ?? 'en');
    const subjectTitle = labels
      ? (languages.map((language) => labels[language]).find((label) => label !== undefined) ??
        Object.values(labels)[0] ??
        verificationRequest.catalogueSubjectId)
      : verificationRequest.catalogueSubjectId;
    return { accountId, verificationRequest, subjectTitle };
  });

export const searchVerificationSubjects = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (!input || typeof input !== 'object' || typeof (input as { query?: unknown }).query !== 'string')
      throw new Error('Invalid query');
    const query = (input as { query: string }).query;
    // Retain the input's UTF-16 budget without cutting a code point in half.
    return query.slice(0, 100).replace(/[\uD800-\uDBFF]$/u, '');
  })
  .handler(async ({ data: query }) => {
    setResponseHeader('cache-control', 'private, no-store');
    if (!query.trim()) return [];
    const { request } = await viewer();
    try {
      const result = await suggestSubjects(query, request);
      // Native empty suggestions need no eligibility metadata.
      if (result.subjects.length === 0) return [];
      const release = await readRelease();
      if (!release?.types || typeof release.types !== 'object' || Array.isArray(release.types))
        throw new Error('Invalid eligibility metadata');
      const resolved = new Map<string, Set<string>>();
      const roots = (type: string, visited = new Set<string>()): Set<string> => {
        const known = resolved.get(type);
        if (known) return known;
        const definition = Object.hasOwn(release.types, type) ? release.types[type] : undefined;
        if (
          !definition ||
          typeof definition !== 'object' ||
          Array.isArray(definition) ||
          (definition.bases !== undefined &&
            (!Array.isArray(definition.bases) || definition.bases.some((base) => typeof base !== 'string' || !base))) ||
          visited.has(type)
        )
          throw new Error('Invalid eligibility metadata');
        if (type === 'schema:Person' || type === 'schema:Organization') return new Set([type]);
        visited.add(type);
        const result = new Set((definition.bases ?? []).flatMap((base) => [...roots(base, visited)]));
        visited.delete(type);
        resolved.set(type, result);
        return result;
      };
      return result.subjects.flatMap((subject) => {
        const title = subject.summary?.label?.value ?? Object.values(subject.labels)[0] ?? subject.id;
        const baseTypes = roots(subject.type);
        if (baseTypes.has('schema:Person')) return [{ id: subject.id, title, type: m.settings_verification_person() }];
        if (baseTypes.has('schema:Organization'))
          return [{ id: subject.id, title, type: m.settings_verification_organization() }];
        return [];
      });
    } catch {
      // The chooser exposes only its existing failed state and explicit Retry.
      throw new Error(m.settings_verification_search_failed());
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
    const { authorization, accountId } = await viewer();
    if (accountId !== data.accountId)
      return { ok: false as const, status: 409, message: m.settings_verification_identity_changed() };
    const { requestVerification } = await import('./verification-core');
    return requestVerification(kernelClient(), accountId, authorization, data);
  });

export const withdrawVerificationAction = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (!input || typeof input !== 'object' || !uuid((input as { idempotencyKey?: unknown }).idempotencyKey))
      throw new Error('Invalid verification withdrawal');
    return { idempotencyKey: (input as { idempotencyKey: string }).idempotencyKey, accountId: expectedAccount(input) };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const { authorization, accountId } = await viewer();
    if (accountId !== data.accountId)
      return { ok: false as const, status: 409, message: m.settings_verification_identity_changed() };
    const { withdrawVerification } = await import('./verification-core');
    return withdrawVerification(kernelClient(), accountId, authorization, data.idempotencyKey);
  });

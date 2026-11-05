import {
  personReviewPairInput,
  personPublicationInput,
  readPersonPublication,
  personReviewCommandInput,
  readPersonComparison,
  mergePersonComparison,
} from './person-identity';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential, sessionSubject, requestCsrfToken } from '../../session/request';
import { readContextChoices, readContextChoice, contextChoiceInput, contextChoiceId } from '../contexts/choice-native';
import type { ProviderEnvelope, ProviderReader } from './provider-visit';
import { readRelease } from '../../subject/definitions';
import { providerDecisionInput, readProviderDecisionSubjects } from './provider-review-actions';
import {
  decideProviderCandidate,
  prepareProviderQueue,
  readProviderQueue,
  validQueueDecision,
  validQueueScope,
  type QueueScope,
  type QueueState,
} from './provider-queue';

async function viewer() {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  await prepareSession(request, env as Partial<SessionEnv>);
  return viewerCredential(request);
}
// Native reference values have an unknown input type; the generated HTTP client has already read JSON.
// Use the same JSON transport mode as the ordinary Subject page's typed server functions.
export const readProviderQueueAction = createServerFn({ method: 'GET', strict: false })
  .validator((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid review scope');
    const data = value as { scope: QueueScope; cursor?: string; session?: string };
    if (
      Object.keys(data).some((key) => !['scope', 'cursor', 'session'].includes(key)) ||
      !validQueueScope(data.scope) ||
      (data.cursor !== undefined && (typeof data.cursor !== 'string' || data.cursor.length > 4096)) ||
      (data.session !== undefined && (typeof data.session !== 'string' || data.session.length > 16384))
    )
      throw new Error('Invalid review scope');
    return data;
  })
  .handler(async ({ data }): Promise<QueueState> => {
    const authorization = await viewer();
    if (!authorization) return { state: 'denied' };
    return readProviderQueue(kernelClient(), authorization, readRelease(), data.scope, data.cursor, data.session);
  });
export const prepareProviderQueueAction = createServerFn({ method: 'POST', strict: false })
  .validator((value: unknown) => {
    if (!validQueueScope(value)) throw new Error('Invalid review scope');
    return value;
  })
  .handler(async ({ data }): Promise<QueueState> => {
    const authorization = await viewer();
    return authorization ? prepareProviderQueue(kernelClient(), authorization, data) : { state: 'denied' };
  });
export const decideProviderCandidateAction = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!validQueueDecision(value)) throw new Error('Invalid review decision');
    return value;
  })
  .handler(async ({ data }) => {
    const authorization = await viewer();
    return authorization
      ? decideProviderCandidate(kernelClient(), authorization, data)
      : { ok: false as const, reason: 'denied' as const };
  });

export const readProviderQueueSubjectsAction = createServerFn({ method: 'POST', strict: false })
  .validator((value: unknown) => {
    if (!Array.isArray(value) || value.length > 20) throw new Error('Invalid provider refresh');
    return value.map(providerDecisionInput);
  })
  .handler(async ({ data }) => {
    const authorization = await viewer();
    return authorization
      ? readProviderDecisionSubjects(kernelClient(), authorization, data)
      : data.map(({ subject }) => ({ subject, result: { ok: false as const, reason: 'denied' as const } }));
  });

// Admitted mounted callers use actual prepared-reader provenance. Legacy direct exports above retain their contract.
async function preparedProviderReader(write = false) {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  try {
    await prepareSession(request, env as Partial<SessionEnv>);
    const subject = sessionSubject(request);
    const csrfToken = requestCsrfToken(request);
    const reader: ProviderReader | null = subject ? { subject, csrfToken } : null;
    const expected = request.headers.get('X-Provider-Reader');
    const originalToken = request.headers.get('X-Provider-Token');
    const authorization = viewerCredential(request);
    if (
      !reader ||
      !expected ||
      expected !== reader.subject ||
      !authorization ||
      (originalToken !== null && originalToken !== reader.csrfToken) ||
      (write && (!originalToken || originalToken !== reader.csrfToken))
    )
      return { request, reader, authorization: null };
    return { request, reader, authorization };
  } catch {
    return { request, reader: null, authorization: null };
  }
}
function queueReadInput(value: unknown) {
  if (!value || typeof value !== 'object') throw new Error('Invalid review scope');
  const input = value as { scope: QueueScope; cursor?: string; session?: string };
  if (
    Object.keys(input).some((key) => !['scope', 'cursor', 'session'].includes(key)) ||
    !validQueueScope(input.scope) ||
    (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 4096)) ||
    (input.session !== undefined && (typeof input.session !== 'string' || input.session.length > 16384))
  )
    throw new Error('Invalid review scope');
  return input;
}
export const readProviderScopeAction = createServerFn({ method: 'GET', strict: false })
  .validator(queueReadInput)
  .handler(async ({ data }): Promise<ProviderEnvelope<QueueState>> => {
    const prepared = await preparedProviderReader();
    const result = prepared.authorization
      ? await readProviderQueue(
          kernelClient(),
          prepared.authorization,
          readRelease(),
          data.scope,
          data.cursor,
          data.session,
        )
      : { state: 'denied' as const };
    return { reader: prepared.reader, result };
  });
export const prepareProviderScopeAction = createServerFn({ method: 'POST', strict: false })
  .validator((input: unknown) => {
    if (!validQueueScope(input)) throw new Error('Invalid review scope');
    return input;
  })
  .handler(async ({ data }): Promise<ProviderEnvelope<QueueState>> => {
    const prepared = await preparedProviderReader(true);
    const result = prepared.authorization
      ? await prepareProviderQueue(kernelClient(), prepared.authorization, data)
      : { state: 'denied' as const };
    return { reader: prepared.reader, result };
  });
export const decideProviderScopeAction = createServerFn({ method: 'POST', strict: false })
  .validator((input: unknown) => {
    if (!validQueueDecision(input)) throw new Error('Invalid review decision');
    return input;
  })
  .handler(async ({ data }) => {
    const prepared = await preparedProviderReader(true);
    const result = prepared.authorization
      ? await decideProviderCandidate(kernelClient(), prepared.authorization, data)
      : { ok: false as const, reason: 'denied' as const };
    return { reader: prepared.reader, result };
  });
export const readProviderScopeSubjectsAction = createServerFn({ method: 'POST', strict: false })
  .validator((input: unknown) => {
    if (!Array.isArray(input) || input.length > 20) throw new Error('Invalid provider refresh');
    return input.map(providerDecisionInput);
  })
  .handler(async ({ data }) => {
    const prepared = await preparedProviderReader();
    const result = prepared.authorization
      ? await readProviderDecisionSubjects(kernelClient(), prepared.authorization, data)
      : data.map(({ subject }) => ({ subject, result: { ok: false as const, reason: 'denied' as const } }));
    return { reader: prepared.reader, result };
  });
export const searchProviderContextsAction = createServerFn({ method: 'GET', strict: false })
  .validator((input: { query: string; cursor?: string }) => {
    if (!input || contextChoiceInput(input)) throw new Error('Invalid Context search');
    return { query: input.query, ...(input.cursor !== undefined ? { cursor: input.cursor } : {}) };
  })
  .handler(async ({ data }) => {
    const prepared = await preparedProviderReader();
    const result = prepared.authorization
      ? await readContextChoices(kernelClient().contexts, prepared.authorization, {
          ...data,
          signal: prepared.request.signal,
        })
      : { kind: 'denied' as const };
    return { reader: prepared.reader, result };
  });
export const resolveProviderContextAction = createServerFn({ method: 'GET', strict: false })
  .validator((input: { id: string }) => {
    if (!input || typeof input.id !== 'string' || !contextChoiceId.test(input.id)) throw new Error('Invalid Context');
    return { id: input.id };
  })
  .handler(async ({ data }) => {
    const prepared = await preparedProviderReader();
    const result = prepared.authorization
      ? await readContextChoice(kernelClient(), prepared.authorization, data.id, prepared.request.signal)
      : { kind: 'denied' as const };
    return { reader: prepared.reader, result };
  });

export const compareProviderPersonsAction = createServerFn({ method: 'POST', strict: false })
  .validator(personReviewPairInput)
  .handler(async ({ data }) => {
    const prepared = await preparedProviderReader();
    const result = prepared.authorization
      ? await readPersonComparison(kernelClient(), prepared.authorization, data, prepared.request.signal)
      : { ok: false as const, reason: 'denied' as const };
    return { reader: prepared.reader, result };
  });
export const mergeProviderPersonsAction = createServerFn({ method: 'POST', strict: false })
  .validator(personReviewCommandInput)
  .handler(async ({ data }) => {
    const prepared = await preparedProviderReader(true);
    const result = prepared.authorization
      ? await mergePersonComparison(kernelClient(), prepared.authorization, data, prepared.request.signal)
      : { ok: false as const, reason: 'denied' as const };
    return { reader: prepared.reader, result };
  });

export const readPersonPublicationAction = createServerFn({ method: 'POST', strict: false })
  .validator(personPublicationInput)
  .handler(async ({ data }) => {
    const prepared = await preparedProviderReader();
    const result = prepared.authorization
      ? await readPersonPublication(kernelClient(), prepared.authorization, data, prepared.request.signal)
      : { ok: false as const, reason: 'denied' as const };
    return { reader: prepared.reader, result };
  });

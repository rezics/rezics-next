import { createKernelClient } from '@rezics/client';
import { Value } from 'typebox/value';
import {
  QuestionManagementResponseSchema,
  RatingQuestionLabelHistorySchema,
} from '../../../../../services/kernel/src/rating/schemas.ts';
import { requestLanguages } from '../../kernel/languages';
import { parseQuestionManagementIntent } from './intent';
import type {
  QuestionManagementAddress,
  QuestionManagementCommandResult,
  QuestionManagementHistoryRead,
  QuestionManagementIntent,
  QuestionManagementPageData,
} from './types';

const MAX_RESPONSE_BYTES = 1_048_576;

export type QuestionManagementSourceResult =
  | { state: 'ready'; page: QuestionManagementPageData }
  | { state: 'denied' | 'concealed' | 'stale-cursor' | 'unavailable' };

async function boundedBody(response: Response): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('Question management response exceeds 1 MiB');
  }
  if (!response.body) return new ArrayBuffer(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error('Question management response exceeds 1 MiB');
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new ArrayBuffer(length);
  const view = new Uint8Array(body);
  let offset = 0;
  for (const chunk of chunks) {
    view.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function boundedResponse(response: Response): Promise<Response> {
  const body = await boundedBody(response);
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function clientFor(input: {
  origin: string;
  authorization: string;
  csrfToken: string;
  locale: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}) {
  const languages = requestLanguages(input.locale);
  const transport = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', input.authorization);
    headers.set(
      'accept-language',
      languages.map((language, index) => `${language}${index ? `;q=${1 - index / 10}` : ''}`).join(', '),
    );
    headers.set('x-csrf-token', input.csrfToken);
    return boundedResponse(
      await (input.fetcher ?? fetch)(url, {
        ...init,
        headers,
        signal: input.signal ?? init?.signal ?? null,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'manual',
      }),
    );
  }) as typeof fetch;
  return createKernelClient(input.origin, { fetch: transport });
}

function managementPath(address: QuestionManagementAddress): string {
  const query = new URLSearchParams();
  if (address.selectedQuestionId) query.set('selectedQuestionId', address.selectedQuestionId);
  if (address.cursor) query.set('cursor', address.cursor);
  const encoded = query.toString();
  const suffix = encoded ? `?${encoded}` : '';
  return `/v1/realms/${encodeURIComponent(address.realmId)}/rating-questions/management${suffix}`;
}

/** Minimal local consumer seam for the mounted management source. It checks the mounted closed schema before use. */
export async function readQuestionManagementSource(input: {
  origin: string;
  authorization: string;
  address: QuestionManagementAddress;
  locale: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}): Promise<QuestionManagementSourceResult> {
  const languages = requestLanguages(input.locale);
  let response: Response;
  try {
    response = await (input.fetcher ?? fetch)(new URL(managementPath(input.address), input.origin), {
      method: 'GET',
      cache: 'no-store',
      headers: {
        authorization: input.authorization,
        accept: 'application/json',
        'accept-language': languages
          .map((language, index) => `${language}${index ? `;q=${1 - index / 10}` : ''}`)
          .join(', '),
      },
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch {
    return { state: 'unavailable' };
  }

  if (response.status === 401) return { state: 'denied' };
  if (response.status === 403) return { state: 'denied' };
  if (response.status === 404) return { state: 'concealed' };
  if (response.status === 409) return { state: 'stale-cursor' };
  if (!response.ok) return { state: 'unavailable' };

  try {
    const body = await boundedBody(response);
    const source: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    if (!Value.Check(QuestionManagementResponseSchema, source)) return { state: 'unavailable' };
    const page = source as QuestionManagementPageData;
    if (
      page.realmId !== input.address.realmId ||
      page.directory.ratingQuestions.some((question) => question.realmId !== input.address.realmId) ||
      (input.address.selectedQuestionId === null
        ? page.selected !== null
        : page.selected?.question.id !== input.address.selectedQuestionId ||
          page.selected.question.realmId !== input.address.realmId)
    )
      return { state: 'unavailable' };
    return { state: 'ready', page };
  } catch {
    return { state: 'unavailable' };
  }
}

/** Session-bound native methods keep caption history and authoring on the installed Client contracts. */
export async function createQuestionManagementClient(input: {
  origin: string;
  authorization: string;
  accountId: string;
  csrfToken: string;
  credentialEpisode: string;
  csrfEpisode: string;
  locale: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}) {
  const client = clientFor(input);
  const matches = (intent: QuestionManagementIntent) =>
    intent.viewer === input.accountId &&
    intent.credentialEpisode === input.credentialEpisode &&
    intent.csrfEpisode === input.csrfEpisode &&
    intent.csrfToken === input.csrfToken &&
    intent.locale === input.locale;

  async function history(questionId: string, cursor: string | null): Promise<QuestionManagementHistoryRead> {
    const unavailable = (state: 'stale-cursor' | 'unavailable'): QuestionManagementHistoryRead => ({
      state,
      questionId,
      cursor,
    });
    if (cursor !== null && (cursor.length === 0 || cursor.length > 4096)) return unavailable('stale-cursor');
    try {
      const result = await client['rating-questions']({ questionId }).labels.get({
        query: { limit: 20, ...(cursor === null ? {} : { cursor }) },
      });
      if (result.status === 409) return unavailable('stale-cursor');
      if (result.status !== 200 || !Value.Check(RatingQuestionLabelHistorySchema, result.data))
        return unavailable('unavailable');
      if (
        result.data.labels.length > 20 ||
        (result.data.next !== null && result.data.next.length > 4096) ||
        result.data.labels.some((label) => label.questionId !== questionId)
      )
        return unavailable('unavailable');
      return { state: 'ready', questionId, cursor, page: result.data };
    } catch {
      return unavailable('unavailable');
    }
  }

  async function execute(value: unknown): Promise<QuestionManagementCommandResult> {
    let intent: QuestionManagementIntent;
    try {
      intent = parseQuestionManagementIntent(value);
    } catch {
      return { kind: 'invalid' };
    }
    if (!matches(intent)) return { kind: 'stale' };
    const options = {
      headers: {
        'idempotency-key': JSON.stringify(intent.key),
        'x-csrf-token': intent.csrfToken,
      },
    };
    try {
      let response:
        | Awaited<ReturnType<ReturnType<typeof client.realms>['rating-questions']['post']>>
        | Awaited<ReturnType<ReturnType<(typeof client)['rating-questions']>['label']['put']>>
        | Awaited<ReturnType<ReturnType<(typeof client)['rating-questions']>['$retire']['post']>>;
      if (intent.action === 'create') {
        response = await client.realms({ realmId: intent.realmId })['rating-questions'].post(intent.body, options);
      } else if (intent.action === 'caption') {
        response = await client['rating-questions']({ questionId: intent.questionId }).label.put(intent.body, options);
      } else if (intent.action === 'retire') {
        response = await client['rating-questions']({ questionId: intent.questionId })['$retire'].post(
          intent.body,
          options,
        );
      } else {
        response = await client['rating-questions']({ questionId: intent.questionId })['$restore'].post(
          intent.body,
          options,
        );
      }
      if (response.status === 409 || response.status === 404) return { kind: 'stale' };
      if (response.status === 401 || response.status === 403) return { kind: 'denied' };
      if (response.status === 400 || response.status === 422) return { kind: 'invalid' };
      if (response.status < 200 || response.status >= 300) {
        const problem = response.error?.value;
        if (
          problem &&
          typeof problem === 'object' &&
          'effect_status' in problem &&
          problem.effect_status === 'not_applied'
        )
          return { kind: 'unavailable' };
        return { kind: 'uncertain' };
      }

      const data = response.data as unknown as Record<string, unknown>;
      if (intent.action === 'create') {
        if (
          response.status === 201 &&
          typeof data.id === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.id) &&
          data.realmId === intent.realmId &&
          data.meaning === intent.body.meaning &&
          data.label === intent.body.label &&
          data.canonicalLabel === intent.body.label &&
          data.labelRevision === 1 &&
          data.revision === 1 &&
          data.grain === intent.body.grain &&
          JSON.stringify(data.scale) === JSON.stringify(intent.body.scale) &&
          data.lifecycle !== null &&
          typeof data.lifecycle === 'object' &&
          'state' in data.lifecycle &&
          data.lifecycle.state === 'active' &&
          'revision' in data.lifecycle &&
          data.lifecycle.revision === 1
        )
          return { kind: 'acknowledged', questionId: data.id };
      } else if (intent.action === 'caption') {
        if (
          response.status === 200 &&
          data.questionId === intent.questionId &&
          data.labelRevision === intent.body.expectedLabelRevision + 1 &&
          data.label === intent.body.label
        )
          return { kind: 'acknowledged', questionId: intent.questionId };
      } else {
        const lifecycle = data.lifecycle;
        const state = intent.action === 'retire' ? 'retired' : 'active';
        if (
          response.status === 200 &&
          data.questionId === intent.questionId &&
          lifecycle &&
          typeof lifecycle === 'object' &&
          'state' in lifecycle &&
          lifecycle.state === state &&
          'revision' in lifecycle &&
          lifecycle.revision === intent.body.expectedLifecycleRevision + 1
        )
          return { kind: 'acknowledged', questionId: intent.questionId };
      }
      return { kind: 'uncertain' };
    } catch {
      return { kind: 'uncertain' };
    }
  }

  return { history, execute };
}

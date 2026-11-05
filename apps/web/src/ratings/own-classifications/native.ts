import { createKernelClient } from '@rezics/client';
import * as v from 'valibot';
import { requestLanguages } from '../../kernel/languages';
import { classificationSearch, indexOwnClassifications, OWN_CLASSIFICATIONS_SOURCE } from './inventory';
import { nativeClassificationsPage } from './native-page';
import { parseClassificationIntent, type ClassificationIntent } from './intent';
import type {
  ClassificationCommandResult,
  ClassificationFrontier,
  ClassificationReview,
  OwnClassificationsRead,
} from './types';

const MAX_BYTES = 1_048_576;
const decimal = v.pipe(v.string(), v.regex(/^[1-9][0-9]*$/));
const ownSchema = v.strictObject({
  associationId: v.pipe(v.string(), v.uuid()),
  hasBallot: v.boolean(),
  assessment: v.nullable(v.picklist(['support', 'oppose'])),
  falsePositive: v.boolean(),
  revision: v.nullable(decimal),
  pending: v.boolean(),
});

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Bound bytes before the public client materializes JSON, including chunked responses without Content-Length. */
async function bounded(response: Response): Promise<Response> {
  if (Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error('Classification response exceeds 1 MiB');
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('Classification response exceeds 1 MiB');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Session-scoped adapter using only the installed mounted Client methods and public success declarations. */
export async function createOwnClassificationClient(input: {
  origin: string;
  authorization: string;
  accountId: string;
  csrfToken: string;
  locale: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}) {
  const credential = await digest(
    JSON.stringify([input.origin, input.accountId, input.authorization, input.csrfToken]),
  );
  const transport = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', input.authorization);
    headers.set(
      'accept-language',
      requestLanguages(input.locale)
        .map((tag, index) => (index === 0 ? tag : `${tag};q=${Math.max(1 - index / 10, 0.1).toFixed(1)}`))
        .join(', '),
    );
    return bounded(
      await (input.fetcher ?? globalThis.fetch)(url, {
        ...init,
        headers,
        signal: input.signal ?? null,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'manual',
      }),
    );
  }) as typeof fetch;
  const client = createKernelClient(input.origin, { fetch: transport });
  const failure = (
    frontier: ClassificationFrontier,
    state: Exclude<OwnClassificationsRead['state'], 'ready'> = 'unavailable',
  ): OwnClassificationsRead => ({ state, page: null, frontier, subject: input.accountId, locale: input.locale });
  const matches = (intent: ClassificationIntent) =>
    intent.viewer === input.accountId &&
    intent.credential === credential &&
    intent.csrfToken === input.csrfToken &&
    intent.locale === input.locale;
  const assessment = (intent: ClassificationIntent) =>
    client.subjects({ id: intent.subjectId })['classification-associations']({ associationId: intent.associationId })
      .assessment;
  return {
    async read(frontier: ClassificationFrontier): Promise<OwnClassificationsRead> {
      try {
        const response = await client.me['classification-assessments'].get({ query: classificationSearch(frontier) });
        if (response.status !== 200) {
          const code = response.error?.value;
          const problem = code && typeof code === 'object' && 'code' in code ? code.code : null;
          return failure(
            frontier,
            response.status === 401
              ? 'signed-out'
              : response.status === 403
                ? 'denied'
                : response.status === 400
                  ? 'invalid-address'
                  : problem === 'stale_cursor'
                    ? 'stale-continuation'
                    : 'unavailable',
          );
        }
        const page = nativeClassificationsPage(response.data);
        if (page.viewer.accountId !== input.accountId) return failure(frontier);
        indexOwnClassifications(page, frontier);
        return {
          state: 'ready',
          page,
          frontier,
          subject: input.accountId,
          locale: input.locale,
          source: OWN_CLASSIFICATIONS_SOURCE,
          credential,
          observation: await digest(JSON.stringify(page)),
        };
      } catch {
        return failure(frontier);
      }
    },
    async execute(value: ClassificationIntent): Promise<ClassificationCommandResult> {
      const intent = parseClassificationIntent(value);
      if (!matches(intent)) return { kind: 'stale' };
      try {
        const options = {
          query: { expectedRevision: intent.precondition },
          headers: { 'idempotency-key': JSON.stringify(intent.key) },
        };
        const endpoint = assessment(intent);
        const response =
          intent.method === 'PUT' && intent.body
            ? await endpoint.put(intent.body, options)
            : await endpoint.delete(undefined, options);
        if (intent.method === 'DELETE' && response.status === 204) return { kind: 'acknowledged' };
        if (
          intent.method === 'PUT' &&
          response.status === 200 &&
          response.data &&
          'associationId' in response.data &&
          response.data.associationId === intent.associationId &&
          'revision' in response.data &&
          v.is(decimal, response.data.revision) &&
          'delivery' in response.data &&
          (response.data.delivery === 'enqueued' || response.data.delivery === 'unchanged')
        )
          return { kind: 'acknowledged' };
        if (response.status === 409 || response.status === 404) return { kind: 'stale' };
        if (response.status === 401 || response.status === 403) return { kind: 'denied' };
        const problem = response.error?.value;
        if (
          problem &&
          typeof problem === 'object' &&
          'effect_status' in problem &&
          problem.effect_status === 'not_applied'
        )
          return { kind: 'unavailable' };
        return { kind: 'uncertain' };
      } catch {
        return { kind: 'uncertain' };
      }
    },
    async review(value: ClassificationIntent): Promise<ClassificationReview> {
      const intent = parseClassificationIntent(value);
      if (!matches(intent) || intent.readback === null) return { kind: 'unavailable' };
      try {
        const response = await assessment(intent).get();
        if (response.status !== 200 || !v.is(ownSchema, response.data)) return { kind: 'unavailable' };
        const own = response.data;
        if (
          own.associationId !== intent.associationId ||
          (own.hasBallot
            ? own.assessment === null || own.revision === null
            : own.assessment !== null || own.falsePositive)
        )
          return { kind: 'unavailable' };
        return { kind: 'current', own };
      } catch {
        return { kind: 'unavailable' };
      }
    },
  };
}

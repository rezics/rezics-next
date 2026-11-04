import { Value } from 'typebox/value';
import { QuestionManagementResponseSchema } from '../../../../../services/kernel/src/rating/schemas.ts';
import { requestLanguages } from '../../kernel/languages';
import type { QuestionManagementAddress, QuestionManagementPageData } from './types';

const MAX_RESPONSE_BYTES = 1_048_576;

export type QuestionManagementSourceResult =
  | { state: 'ready'; page: QuestionManagementPageData }
  | { state: 'denied' | 'concealed' | 'stale-cursor' | 'unavailable' };

async function boundedBody(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('Question management response exceeds 1 MiB');
  }
  if (!response.body) return new Uint8Array();

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
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
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
        'accept-language': languages.map((language, index) => `${language}${index ? `;q=${1 - index / 10}` : ''}`).join(', '),
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

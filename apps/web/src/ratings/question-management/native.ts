import {
  createKernelClient,
  QuestionManagementResponseSchema,
  RatingQuestionLabelHistorySchema,
  type KernelClient,
  type QuestionCreateResult,
  type QuestionLabelHistory,
  type QuestionLabelResult,
  type QuestionLifecycleResult,
} from '@rezics/client';
import { Value } from 'typebox/value';
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
const QUESTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

/** Bounded bytes must be exact UTF-8 before the installed client parses them; malformed bytes stay unavailable. */
async function boundedResponse(response: Response): Promise<Response> {
  const body = await boundedBody(response);
  new TextDecoder('utf-8', { fatal: true }).decode(body);
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function clientFor(input: {
  origin: string;
  authorization: string;
  csrfToken?: string;
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
    if (input.csrfToken !== undefined) headers.set('x-csrf-token', input.csrfToken);
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

function isManagementPage(value: unknown): value is QuestionManagementPageData {
  return Value.Check(QuestionManagementResponseSchema(), value);
}

function isLabelHistory(value: unknown): value is QuestionLabelHistory {
  return Value.Check(RatingQuestionLabelHistorySchema, value);
}

function commandStatus(response: {
  status: number;
  error?: { value?: unknown } | null;
}): QuestionManagementCommandResult | null {
  if (response.status === 409 || response.status === 404) return { kind: 'stale' };
  if (response.status === 401 || response.status === 403) return { kind: 'denied' };
  if (response.status === 400 || response.status === 422) return { kind: 'invalid' };
  if (response.status < 200 || response.status >= 300) {
    const problem = response.error?.value;
    if (problem && typeof problem === 'object' && 'effect_status' in problem && problem.effect_status === 'not_applied')
      return { kind: 'unavailable' };
    return { kind: 'uncertain' };
  }
  return null;
}

type QuestionCreatePost = ReturnType<KernelClient['realms']>['rating-questions']['post'];
type QuestionCreateData = NonNullable<
  Awaited<QuestionCreatePost extends (...args: never[]) => infer Result ? Result : QuestionCreatePost>['data']
>;

function acknowledgedCreate(
  data: QuestionCreateData,
  intent: Extract<QuestionManagementIntent, { action: 'create' }>,
): data is QuestionCreateData & { id: string } {
  const created = data as QuestionCreateResult;
  return (
    QUESTION_ID.test(created.id) &&
    created.realmId === intent.realmId &&
    created.meaning === intent.body.meaning &&
    created.label === intent.body.label &&
    created.canonicalLabel === intent.body.label &&
    created.labelRevision === 1 &&
    created.revision === 1 &&
    created.grain === intent.body.grain &&
    created.scale.min === intent.body.scale.min &&
    created.scale.max === intent.body.scale.max &&
    created.scale.displayStep === intent.body.scale.displayStep &&
    created.lifecycle !== undefined &&
    created.lifecycle.state === 'active' &&
    created.lifecycle.revision === 1
  );
}

function acknowledgedCaption(
  data: QuestionLabelResult,
  intent: Extract<QuestionManagementIntent, { action: 'caption' }>,
): boolean {
  return (
    data.questionId === intent.questionId &&
    data.labelRevision === intent.body.expectedLabelRevision + 1 &&
    data.label === intent.body.label
  );
}

function acknowledgedLifecycle(
  data: QuestionLifecycleResult,
  intent: Extract<QuestionManagementIntent, { action: 'retire' | 'restore' }>,
): boolean {
  return (
    data.questionId === intent.questionId &&
    data.lifecycle.state === (intent.action === 'retire' ? 'retired' : 'active') &&
    data.lifecycle.revision === intent.body.expectedLifecycleRevision + 1
  );
}

/** Reads the mounted management page through the installed Realm callable, with its status, byte and shape checks. */
export async function readQuestionManagementSource(input: {
  origin: string;
  authorization: string;
  address: QuestionManagementAddress;
  locale: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}): Promise<QuestionManagementSourceResult> {
  const client = clientFor(input);
  const result = await client
    .realms({ realmId: input.address.realmId })
    ['rating-questions'].management.get({
      query: {
        ...(input.address.selectedQuestionId ? { selectedQuestionId: input.address.selectedQuestionId } : {}),
        ...(input.address.cursor ? { cursor: input.address.cursor } : {}),
      },
    })
    .catch(() => undefined);
  if (!result) return { state: 'unavailable' };

  if (result.status === 401 || result.status === 403) return { state: 'denied' };
  if (result.status === 404) return { state: 'concealed' };
  if (result.status === 409) return { state: 'stale-cursor' };
  if (result.status !== 200) return { state: 'unavailable' };

  try {
    if (!isManagementPage(result.data)) return { state: 'unavailable' };
    const page = result.data;
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
      if (result.status !== 200 || !isLabelHistory(result.data)) return unavailable('unavailable');
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
      if (intent.action === 'create') {
        const response = await client
          .realms({ realmId: intent.realmId })
          ['rating-questions'].post(intent.body, options);
        const failed = commandStatus(response);
        if (failed) return failed;
        if (response.status === 201 && response.data && acknowledgedCreate(response.data, intent))
          return { kind: 'acknowledged', questionId: response.data.id };
        return { kind: 'uncertain' };
      }
      if (intent.action === 'caption') {
        const response = await client['rating-questions']({ questionId: intent.questionId }).label.put(
          intent.body,
          options,
        );
        const failed = commandStatus(response);
        if (failed) return failed;
        if (response.status === 200 && response.data && acknowledgedCaption(response.data, intent))
          return { kind: 'acknowledged', questionId: intent.questionId };
        return { kind: 'uncertain' };
      }
      const response =
        intent.action === 'retire'
          ? await client['rating-questions']({ questionId: intent.questionId })['$retire'].post(intent.body, options)
          : await client['rating-questions']({ questionId: intent.questionId })['$restore'].post(intent.body, options);
      const failed = commandStatus(response);
      if (failed) return failed;
      if (response.status === 200 && response.data && acknowledgedLifecycle(response.data, intent))
        return { kind: 'acknowledged', questionId: intent.questionId };
      return { kind: 'uncertain' };
    } catch {
      return { kind: 'uncertain' };
    }
  }

  return { history, execute };
}

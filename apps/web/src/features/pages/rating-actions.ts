import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import { prepareExpectedReader, type ExpectedReader } from '../../session/expected-reader';
import type { PersonalScoreWriteResult } from '../../library/score-write';
import {
  QUESTION,
  readRatingQuestion,
  validRatingUnits,
  writeRatingVote,
  preparedRatingReader,
  writeOwnRating,
} from './subject-ratings';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateChange(input: unknown): {
  subjectId: string;
  units: number | null;
  idempotencyKey: string;
  expectedReader: string;
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid rating change');
  const value = input as Record<string, unknown>;
  if (
    typeof value.subjectId !== 'string' ||
    !uuid.test(value.subjectId) ||
    (value.units !== null && (typeof value.units !== 'number' || !Number.isSafeInteger(value.units))) ||
    typeof value.idempotencyKey !== 'string' ||
    !uuid.test(value.idempotencyKey) ||
    typeof value.expectedReader !== 'string' ||
    !value.expectedReader ||
    value.expectedReader.length > 128
  )
    throw new Error('Invalid rating change');
  return value as { subjectId: string; units: number | null; idempotencyKey: string; expectedReader: string };
}

/** Apply one enhanced vote only when the request's prepared credential matches its originating reader. */
export async function writeSubjectRatingForCurrentReader(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: ReturnType<typeof validateChange>,
): Promise<PersonalScoreWriteResult> {
  try {
    await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    if (!authorization) return 'rejected';
    const reader = await preparedRatingReader(request, authorization);
    if (reader !== input.expectedReader) return 'rejected';
    const question = await readRatingQuestion(client);
    if (input.units !== null && (!question || !validRatingUnits(input.units, question.scale))) return 'rejected';
    return writeRatingVote(client, {
      subjectId: input.subjectId,
      questionId: QUESTION,
      authorization,
      units: input.units,
      idempotencyKey: input.idempotencyKey,
      ...(question
        ? {
            observation: {
              subjectId: input.subjectId,
              question: {
                id: question.id,
                revision: question.revision,
                grain: question.grain,
                meaning: question.meaning ?? question.label,
                scale: question.scale,
              },
            },
          }
        : {}),
    });
  } catch {
    return 'uncertain';
  }
}

/** The enhanced rating control writes through the session held by the Worker. */
export const changeSubjectRating = createServerFn({ method: 'POST' })
  .validator(validateChange)
  .handler(async ({ data }): Promise<PersonalScoreWriteResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    try {
      const { env } = await import('cloudflare:workers');
      const { kernelClient } = await import('../../kernel/client');
      return writeSubjectRatingForCurrentReader(kernelClient(), request, env as Partial<SessionEnv>, data);
    } catch {
      return 'uncertain';
    }
  });

type FormResult = 'success' | 'failure' | 'signed-out';

const localizedSubjectPath =
  /^\/(?:de|en|es|fr|ja|ko|zh-Hans|zh-Hant)\/subjects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[^/]{1,128}$/i;
const formLimit = 4096;

async function formFields(request: Request): Promise<URLSearchParams | null> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded')
    return null;
  const reader = request.clone().body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > formLimit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

/** Ordinary HTML form fallback for readers who have JavaScript disabled. */
export async function postSubjectRatingForm(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
): Promise<FormResult> {
  const url = new URL(request.url);
  const path = localizedSubjectPath.exec(url.pathname);
  if (request.method !== 'POST' || !path) return 'failure';
  const fields = await formFields(request);
  if (!fields) return 'failure';
  const intents = fields.getAll('intent');
  if (intents.length !== 1 || !['save', 'clear'].includes(intents[0]!)) return 'failure';
  let units: number | null;
  if (intents[0] === 'clear') {
    units = null;
  } else {
    const values = fields.getAll('units');
    if (values.length !== 1 || !/^(?:0|-?[1-9]\d*)$/.test(values[0]!)) return 'failure';
    units = Number(values[0]);
    if (!Number.isSafeInteger(units)) return 'failure';
  }

  // The HTML is shared across readers, so it cannot embed a reader-specific CSRF token. The request middleware
  // requires an exact allowed Origin for this one form endpoint; resolve the session from a safe read clone here.
  const sessionRequest = new Request(request.url, { method: 'GET', headers: request.headers });
  try {
    await prepareSession(sessionRequest, sessionEnv);
  } catch {
    return 'signed-out';
  }
  const authorization = viewerCredential(sessionRequest);
  if (!authorization) return 'signed-out';
  return (await writeOwnRating(client, path[1]!, authorization, units, crypto.randomUUID())) ? 'success' : 'failure';
}

export type QuestionBoundRatingInput = ExpectedReader & {
  subjectId: string;
  units: number | null;
  idempotencyKey: string;
  question: {
    id: string;
    revision: number;
    grain: string;
    meaning: string;
    scale: { min: number; max: number; displayStep: number };
  };
};
function validateBoundRating(input: QuestionBoundRatingInput): QuestionBoundRatingInput {
  validateChange(input);
  const q = input.question;
  if (
    !q ||
    typeof q.id !== 'string' ||
    !uuid.test(q.id) ||
    !Number.isSafeInteger(q.revision) ||
    q.revision < 1 ||
    typeof q.grain !== 'string' ||
    typeof q.meaning !== 'string' ||
    !q.scale ||
    ![q.scale.min, q.scale.max, q.scale.displayStep].every(Number.isSafeInteger) ||
    q.scale.min >= q.scale.max ||
    q.scale.displayStep < 1 ||
    (input.units !== null && !validRatingUnits(input.units, q.scale)) ||
    typeof input.expectedCredential !== 'string' ||
    !input.expectedCredential ||
    input.expectedCredential.length > 256 ||
    new TextEncoder().encode(JSON.stringify({ subjectId: input.subjectId, question: q })).byteLength > 2048
  )
    throw new Error('Invalid bound rating change');
  return structuredClone(input);
}
export async function writeQuestionBoundRatingForCurrentReader(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  input: QuestionBoundRatingInput,
) {
  input = validateBoundRating(input);
  // Conditional native providers remain unavailable without their atomic participant guard.
  if (input.question.id !== QUESTION) return 'rejected' as const;
  const authorization = await prepareExpectedReader(request, env, input);
  if (!authorization) return 'rejected' as const;
  return writeRatingVote(client, {
    ...input,
    questionId: input.question.id,
    authorization,
    observation: { subjectId: input.subjectId, question: input.question },
  });
}
export const changeQuestionBoundRating = createServerFn({ method: 'POST' })
  .validator(validateBoundRating)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      const { env } = await import('cloudflare:workers');
      const { kernelClient } = await import('../../kernel/client');
      return await writeQuestionBoundRatingForCurrentReader(
        kernelClient(),
        getRequest(),
        env as Partial<SessionEnv>,
        data,
      );
    } catch {
      return 'uncertain' as const;
    }
  });

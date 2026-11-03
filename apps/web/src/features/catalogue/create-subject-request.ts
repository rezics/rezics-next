import type { KernelClient } from '@rezics/client';
import { pickText } from '@rezics/composition';
import { checkSubjectStructure } from '@rezics/definitions/validate';
import { MediaProblem } from '../../media/kernel';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import { subjectHref } from '../../subject/subject-href';
import type { CreateFailure, CreateResult, CreateSubjectCommand, CreatedReader } from './create-subject';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** An ordinary public read of the exact created identity; no privileged fallback or merge substitution. */
export async function readCreatedSubject(client: KernelClient, id: string, locale: string): Promise<CreatedReader> {
  if (!uuid.test(id)) return { state: 'concealed' };
  try {
    const result = await client.subjects({ id }).get();
    if (result.status === 404 || result.status === 403) return { state: 'concealed' };
    if (result.status !== 200 || !result.data || result.data.subject.id !== id) return { state: 'unavailable' };
    return {
      state: 'ready',
      href: subjectHref({ id, label: pickText(result.data.subject.labels, locale).text }, locale).href,
      identity: {
        id: result.data.subject.id,
        type: result.data.subject.type,
        label: pickText(result.data.subject.labels, locale).text,
      },
    };
  } catch {
    return { state: 'unavailable' };
  }
}

function refusal(status: number, problem: unknown): CreateFailure {
  if (status === 401) return { ok: false, reason: 'signed-out' };
  if (status === 403) return { ok: false, reason: 'denied' };
  const code = problem && typeof problem === 'object' ? Reflect.get(problem, 'code') : undefined;
  if (status === 409 || code === 'idempotency_conflict') return { ok: false, reason: 'conflict' };
  if (status === 400 || status === 422) {
    const raw: unknown = problem && typeof problem === 'object' ? Reflect.get(problem, 'errors') : undefined;
    const errors = Array.isArray(raw)
      ? raw.flatMap((error: unknown) => {
          if (!error || typeof error !== 'object') return [];
          const pointer: unknown = Reflect.get(error, 'pointer');
          return typeof pointer === 'string' ? [{ pointer, code: 'invalid_format' as const }] : [];
        })
      : [];
    return { ok: false, reason: 'invalid', errors, refreshDefinitions: true };
  }
  return { ok: false, reason: 'unavailable' };
}

/** Identity and CSRF use the existing BFF. One native client carries its write token into the reader. */
export async function createSubjectRecord(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  command: CreateSubjectCommand,
  locale: string,
  preparedAuthorization?: string,
): Promise<CreateResult> {
  const errors = checkSubjectStructure(command.item).violations;
  if (!command.item.type) errors.push({ pointer: '/type', code: 'required' });
  if (!uuid.test(command.key) || errors.length) return { ok: false, reason: 'invalid', errors };
  try {
    const stale = preparedAuthorization ? false : await prepareSession(request, sessionEnv);
    const authorization = preparedAuthorization ?? viewerCredential(request);
    if (stale || !authorization) return { ok: false, reason: 'signed-out' };
    const headers = { authorization, 'idempotency-key': command.key };
    const response = await client.subjects.post(command.item, { headers });
    if (response.status !== 201 || !response.data) return refusal(response.status, response.error?.value);
    const id = response.data.subject.id;
    if (!uuid.test(id)) return { ok: false, reason: 'unavailable' };
    return { ok: true, id, reader: await readCreatedSubject(client, id, locale) };
  } catch (error) {
    if (error instanceof MediaProblem && error.problem.status === 403) return { ok: false, reason: 'denied' };
    return { ok: false, reason: 'unavailable' };
  }
}

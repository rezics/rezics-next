import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { moderationCommandHeaders, validateModerationKey } from './command-intent';

export type CatalogueReportActionInput = {
  reportId: string;
  subjectId: string;
  idempotencyKey: string;
} & ({ action: 'dismiss' } | { action: 'hide' | 'restore'; reason: string });
export type CatalogueReportActionResult =
  | { ok: true; result: { kind: 'dismissed'; reportId: string; outcome: 'dismissed' } }
  | {
      ok: true;
      result: { kind: 'visibility'; subjectId: string; visibility: 'visible' | 'hidden' | 'taken_down' };
    }
  | { ok: false; state: 'conflict' | 'forbidden' | 'sign-in' | 'unavailable' | 'uncertain' | 'error' };
export type CatalogueReportCommand = (input: CatalogueReportActionInput) => Promise<CatalogueReportActionResult>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const reasonText = (value: unknown) =>
  typeof value === 'string' && value.trim().length > 0 && Array.from(value.trim()).length <= 1024 ? value.trim() : null;

function failure(status: number, error: unknown): CatalogueReportActionResult {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (status === 401) return { ok: false, state: 'sign-in' };
  if (status === 403) return { ok: false, state: 'forbidden' };
  if (status === 404) return { ok: false, state: 'unavailable' };
  if (status === 409 || status === 412 || (status === 422 && code === 'idempotency_conflict'))
    return { ok: false, state: 'conflict' };
  if (status >= 500 || status === 0) return { ok: false, state: 'uncertain' };
  return { ok: false, state: 'error' };
}

/** Only native receipts are presented as confirmed; a lost response remains retryable with its original key. */
export async function sendCatalogueReportAction(
  client: KernelClient,
  input: CatalogueReportActionInput,
  authorization: string,
): Promise<CatalogueReportActionResult> {
  const headers = moderationCommandHeaders(authorization, input.idempotencyKey);
  try {
    if (input.action === 'dismiss') {
      const result = await client.reports({ id: input.reportId }).$dismiss.post({}, { headers });
      if (!result.error && result.data?.reportId === input.reportId && result.data.outcome === 'dismissed')
        return {
          ok: true,
          result: { kind: 'dismissed', reportId: result.data.reportId, outcome: result.data.outcome },
        };
      return failure(result.status, result.error?.value);
    }
    const reason = reasonText(input.reason);
    if (!reason) return { ok: false, state: 'error' };
    const result =
      input.action === 'hide'
        ? await client.subjects({ id: input.subjectId }).$hide.post({ reason }, { headers })
        : await client.subjects({ id: input.subjectId }).$restore.post({ reason }, { headers });
    if (
      !result.error &&
      result.data?.subject === input.subjectId &&
      ['visible', 'hidden', 'taken_down'].includes(result.data.visibility)
    )
      return {
        ok: true,
        result: {
          kind: 'visibility',
          subjectId: result.data.subject,
          visibility: result.data.visibility,
        },
      };
    return failure(result.status, result.error?.value);
  } catch {
    return { ok: false, state: 'uncertain' };
  }
}

function validateCatalogueReportAction(input: unknown): CatalogueReportActionInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid report action');
  const value = input as Record<string, unknown>;
  if (
    typeof value.reportId !== 'string' ||
    !uuid.test(value.reportId) ||
    typeof value.subjectId !== 'string' ||
    !uuid.test(value.subjectId) ||
    (value.action !== 'dismiss' && value.action !== 'hide' && value.action !== 'restore')
  )
    throw new Error('Invalid report action');
  const base = {
    reportId: value.reportId,
    subjectId: value.subjectId,
    idempotencyKey: validateModerationKey(value.idempotencyKey),
  };
  if (value.action === 'dismiss') return { ...base, action: 'dismiss' };
  const reason = reasonText(value.reason);
  if (!reason) throw new Error('Invalid report action reason');
  return { ...base, action: value.action, reason };
}

export const actOnCatalogueReport = createServerFn({ method: 'POST' })
  .validator(validateCatalogueReportAction)
  .handler(async ({ data }): Promise<CatalogueReportActionResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    if (!authorization) return { ok: false, state: 'sign-in' };
    return sendCatalogueReportAction(kernelClient(), data, authorization);
  });

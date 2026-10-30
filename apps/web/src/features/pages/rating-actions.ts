import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import { writeOwnRating } from './subject-ratings';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateChange(input: unknown): { subjectId: string; units: number | null; idempotencyKey: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid rating change');
  const value = input as Record<string, unknown>;
  if (
    typeof value.subjectId !== 'string' ||
    !uuid.test(value.subjectId) ||
    (value.units !== null &&
      (!Number.isSafeInteger(value.units) || (value.units as number) < 0 || (value.units as number) > 20)) ||
    typeof value.idempotencyKey !== 'string' ||
    !uuid.test(value.idempotencyKey)
  )
    throw new Error('Invalid rating change');
  return value as { subjectId: string; units: number | null; idempotencyKey: string };
}

/** The enhanced rating control writes through the session held by the Worker. */
export const changeSubjectRating = createServerFn({ method: 'POST' })
  .validator(validateChange)
  .handler(async ({ data }): Promise<boolean> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    try {
      const { env } = await import('cloudflare:workers');
      const { kernelClient } = await import('../../kernel/client');
      await prepareSession(request, env as Partial<SessionEnv>);
      const authorization = viewerCredential(request);
      if (!authorization) return false;
      return writeOwnRating(kernelClient(), data.subjectId, authorization, data.units, data.idempotencyKey);
    } catch {
      return false;
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
    if (values.length !== 1 || !/^(?:0|[1-9]\d?)$/.test(values[0]!)) return 'failure';
    units = Number(values[0]);
    if (!Number.isSafeInteger(units) || units < 0 || units > 20) return 'failure';
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

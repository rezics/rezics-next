import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { requestCsrfToken, sessionSubject, viewerCredential } from '../session/request';
import { clearLabelFeedback, loadLabelsPage, type LabelsPage } from './labels-read';

export type LabelsAddress = { cursor: string | null; query: string | null; locale: string };
export type LabelsCurrentRead = {
  sessionSubject: string | null;
  requested: LabelsAddress | null;
  page: LabelsPage;
};
function validate(value: unknown): { cursor?: string; query?: string } {
  if (!value || typeof value !== 'object') throw new Error('Invalid label query');
  const input = value as Record<string, unknown>;
  if (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 4096))
    throw new Error('Invalid label cursor');
  if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 4096))
    throw new Error('Invalid label prefix');
  return {
    ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
    ...(typeof input.query === 'string' ? { query: input.query } : {}),
  };
}
async function read(data: ReturnType<typeof validate>): Promise<LabelsCurrentRead> {
  setResponseHeader('cache-control', 'private, no-store');
  setResponseHeader('set-cookie', clearLabelFeedback());
  // A fresh Request has no retained WeakMap credentials. Only the native reader prepares it.
  const request = new Request(getRequest());
  const page = await loadLabelsPage(kernelClient(), request, env as Partial<SessionEnv>, data.cursor, data.query);
  const subject = sessionSubject(request);
  const credential = viewerCredential(request);
  if (!page.signedIn || !subject || !credential)
    return {
      sessionSubject: null,
      requested: null,
      page: { ...page, operations: [], csrfToken: '', labels: [], next: null, query: undefined, feedback: undefined },
    };
  return {
    sessionSubject: subject,
    requested: { cursor: data.cursor ?? null, query: data.query ?? null, locale: requestLocale(request) ?? 'en' },
    // signedIn() may have observed a replacement session. Use this preparation's token instead.
    page: { ...page, csrfToken: requestCsrfToken(request) ?? '' },
  };
}

export const readLabelsPage = createServerFn({ method: 'GET' })
  .validator(validate)
  .handler(async ({ data }) => (await read(data)).page);

export const readLabelsCurrent = createServerFn({ method: 'GET' })
  .validator(validate)
  .handler(({ data }) => read(data));

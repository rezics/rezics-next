import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { requestCsrfToken, sessionSubject, viewerCredential } from '../session/request';
import { clearLabelFeedback, loadLabelsPage, type LabelsPage } from './labels-read';
import { parseLabelsAddress } from './labels-address';

export type LabelsAddress = { cursor: string | null; query: string | null; locale: string };
export type LabelsCurrentRead = {
  sessionSubject: string | null;
  requested: LabelsAddress | null;
  page: LabelsPage;
};
function validate(value: unknown): { cursor?: string; query?: string } {
  if (!value || typeof value !== 'object') throw new Error('Invalid label query');
  const address = parseLabelsAddress(value);
  if (!address.valid) throw new Error(address.issue === 'cursor' ? 'Invalid label cursor' : 'Invalid label prefix');
  return {
    ...(address.cursor === null ? {} : { cursor: address.cursor }),
    ...(address.query === null ? {} : { query: address.query }),
  };
}
async function read(data: ReturnType<typeof validate>): Promise<LabelsCurrentRead> {
  setResponseHeader('cache-control', 'private, no-store');
  setResponseHeader('set-cookie', clearLabelFeedback());
  // A fresh Request has no retained WeakMap credentials. Only the native reader prepares it.
  const request = getRequest().clone() as Request;
  const page = await loadLabelsPage(kernelClient(), request, env as Partial<SessionEnv>, data.cursor, data.query);
  const subject = sessionSubject(request);
  const credential = viewerCredential(request);
  if (!page.signedIn || !subject || !credential)
    return {
      sessionSubject: null,
      requested: null,
      page: {
        signedIn: false,
        ...(page.state ? { state: page.state } : {}),
        operations: [],
        csrfToken: '',
        createKey: page.createKey,
        undoKey: page.undoKey,
        labels: [],
        next: null,
      },
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

import { createKernelClient, SESSION_HEADER } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { Value } from 'typebox/value';
import t from 'typebox';
import { requestLocale } from '../../kernel/client';
import { prepareSession, sessionSubject, viewerCredential } from '../../session/request';
import type { SessionEnv } from '../../session/client';
import { parseOwnMediaInventoryPage } from './wire';
import { OWN_MEDIA_SOURCE, type OwnMediaEraseIntent } from './inventory';

export type OwnMediaRead = Readonly<{
  state: 'ready' | 'signed-out' | 'denied' | 'preparing' | 'unavailable' | 'invalid-cursor';
  page: import('./wire').OwnMediaInventoryPage | null;
  subject: string | null;
  cursor: string | null;
  locale: string;
  source: typeof OWN_MEDIA_SOURCE | null;
}>;

export type OwnMediaEraseResult = 'acknowledged' | 'signed-out' | 'stale' | 'denied' | 'concealed' | 'uncertain';

function inputOf(value: unknown): { cursor: string | null; invalid: boolean } {
  if (!value || typeof value !== 'object') return { cursor: null, invalid: false };
  const input = value as Record<string, unknown>;
  if (input.cursor === null || input.cursor === undefined) return { cursor: null, invalid: input.invalid === true };
  return typeof input.cursor === 'string' && input.cursor.length <= 2048
    ? { cursor: input.cursor, invalid: input.invalid === true }
    : { cursor: null, invalid: true };
}

function createNativeTransport(origin: string, authorization: string, fetcher: typeof fetch = globalThis.fetch) {
  let sessionToken: string | null = null;
  const transport: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', authorization);
      if (sessionToken !== null) headers.set(SESSION_HEADER, sessionToken);
      const response = await fetcher(input, {
        ...init,
        headers,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'manual',
      });
      const next = response.headers.get(SESSION_HEADER);
      if (next !== null) sessionToken = next;
      return response;
    },
    { preconnect: fetcher.preconnect.bind(fetcher) },
  );
  return { transport, client: createKernelClient(origin, { fetch: transport }) };
}

function emptyRead(
  state: Exclude<OwnMediaRead['state'], 'ready'>,
  subject: string | null,
  cursor: string | null,
  locale: string,
): OwnMediaRead {
  return { state, page: null, subject, cursor, locale, source: null };
}

async function readPage(address: { cursor: string | null; invalid: boolean }): Promise<OwnMediaRead> {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  const locale = requestLocale(request) ?? 'en';
  if (address.invalid) return emptyRead('invalid-cursor', null, null, locale);
  const { env } = await import('cloudflare:workers');
  const sessionEnv = env as Partial<SessionEnv>;
  let refused: boolean;
  try {
    refused = await prepareSession(request, sessionEnv);
  } catch {
    return emptyRead('preparing', null, address.cursor, locale);
  }
  const subject = sessionSubject(request) ?? null;
  const authorization = viewerCredential(request);
  if (refused || !subject || !authorization) return emptyRead('signed-out', null, address.cursor, locale);
  const origin = (env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN;
  if (!origin) return emptyRead('unavailable', subject, address.cursor, locale);
  try {
    const { client } = createNativeTransport(origin, authorization);
    const result = await client.media.get(address.cursor === null ? {} : { query: { cursor: address.cursor } });
    if (result.error) {
      if (result.error.status === 401) return emptyRead('signed-out', null, address.cursor, locale);
      if (result.error.status === 404) return emptyRead('denied', subject, address.cursor, locale);
      if (result.error.status === 400) return emptyRead('invalid-cursor', subject, address.cursor, locale);
      return emptyRead('unavailable', subject, address.cursor, locale);
    }
    const page = parseOwnMediaInventoryPage(result.data);
    if (!page) return emptyRead('unavailable', subject, address.cursor, locale);
    return { state: 'ready', page, subject, cursor: address.cursor, locale, source: OWN_MEDIA_SOURCE };
  } catch {
    return emptyRead('unavailable', subject, address.cursor, locale);
  }
}

export const readOwnMediaInventoryForViewer = createServerFn({ method: 'GET' })
  .validator(inputOf)
  .handler(async ({ data }) => readPage(data));

const eraseIntentSchema = t.Object(
  {
    action: t.Literal('media.erase'),
    mediaId: t.String({ minLength: 1, maxLength: 64 }),
    viewer: t.String({ minLength: 1, maxLength: 64 }),
    source: t.Literal(OWN_MEDIA_SOURCE),
    idempotencyKey: t.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);

async function erase(intent: OwnMediaEraseIntent): Promise<OwnMediaEraseResult> {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  const { env } = await import('cloudflare:workers');
  let refused: boolean;
  try {
    refused = await prepareSession(request, env as Partial<SessionEnv>);
  } catch {
    return 'signed-out';
  }
  const authorization = viewerCredential(request);
  if (refused || !authorization) return 'signed-out';
  if (sessionSubject(request) !== intent.viewer) return 'stale';
  const origin = (env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN;
  if (!origin) return 'uncertain';
  try {
    const { transport } = createNativeTransport(origin, authorization);
    const response = await transport(new URL(`/v1/media/${encodeURIComponent(intent.mediaId)}`, origin), {
      method: 'DELETE',
      headers: { 'idempotency-key': JSON.stringify(intent.idempotencyKey) },
      signal: request.signal,
    });
    if (response.status === 204) return 'acknowledged';
    if (response.status === 401) return 'signed-out';
    if (response.status === 403) return 'denied';
    if (response.status === 404) return 'concealed';
    return 'uncertain';
  } catch {
    return 'uncertain';
  }
}

export const executeOwnMediaErase = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!Value.Check(eraseIntentSchema, value)) throw new Error('Invalid media removal intent');
    return value as OwnMediaEraseIntent;
  })
  .handler(async ({ data }) => erase(data));

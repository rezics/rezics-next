import { createHash, randomUUID } from 'node:crypto';
import type { Json, KernelCall } from './semantic-first-public-native.ts';

export type NativeObservation = {
  method: string;
  url: string;
  credential: string;
  key?: string;
  ifMatch?: string;
  body?: unknown;
  status?: number;
  response?: unknown;
  etag?: string;
  correlation?: string;
};

/** Preserve exact request operands and causal session evidence without retaining bearer secrets. */
export function nativeWalkCall(
  kernel: string,
  trace: NativeObservation[],
  fetchImpl: typeof fetch = fetch,
): KernelCall {
  const sessions = new Map<string, string>();
  return async (method, path, options = {}) => {
    const url = new URL(path, kernel);
    for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
    const key = method === 'GET' ? undefined : randomUUID();
    const credential = options.bearer
      ? `bearer-sha256:${createHash('sha256').update(options.bearer).digest('hex')}`
      : 'anonymous';
    const session = sessions.get(credential);
    const observation: NativeObservation = {
      method,
      url: url.href,
      credential,
      ...(key === undefined ? {} : { key }),
      ...(options.ifMatch === undefined ? {} : { ifMatch: options.ifMatch }),
      ...(options.body === undefined ? {} : { body: options.body }),
    };
    trace.push(observation);
    const response = await fetchImpl(url, {
      method,
      signal: AbortSignal.timeout(60_000),
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(key === undefined ? {} : { 'idempotency-key': JSON.stringify(key) }),
        ...(options.ifMatch ? { 'if-match': `"${options.ifMatch}"` } : {}),
        ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
        ...(session ? { 'rezics-session-token': session } : {}),
        'accept-language': 'en',
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const nextSession = response.headers.get('rezics-session-token');
    if (nextSession) sessions.set(credential, nextSession);
    const text = await response.text();
    const body = text ? (JSON.parse(text) as Json) : {};
    const etag = response.headers.get('etag') ?? undefined;
    const correlation = response.headers.get('x-request-id') ?? undefined;
    Object.assign(observation, {
      status: response.status,
      response: body,
      ...(etag === undefined ? {} : { etag }),
      ...(correlation === undefined ? {} : { correlation }),
    });
    return {
      status: response.status,
      headers: response.headers,
      body,
      ...(etag === undefined ? {} : { etag }),
    };
  };
}

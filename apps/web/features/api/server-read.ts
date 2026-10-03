import { headers } from 'next/headers';
import { serverFetch, deadlineFromHeaders, type ServerFetchOptions } from './server-fetch.ts';

/** Proxy overwrites this internal header; a browser cannot extend its budget. */
export async function serverDeadline(incoming?: Headers): Promise<number | undefined> {
  try {
    return deadlineFromHeaders(incoming ?? (await headers()));
  } catch {
    return undefined;
  } // CLI/test callers have no render context.
}

export async function serverRead(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: ServerFetchOptions = {},
): Promise<Response> {
  return serverFetch(input, init, {
    ...options,
    deadlineAt: options.deadlineAt ?? (await serverDeadline()),
  });
}

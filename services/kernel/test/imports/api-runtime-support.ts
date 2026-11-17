import { randomUUID } from 'node:crypto';

export type ApiRuntimeFailure = { error: unknown };

export function importApiRequest(origin: string, path: string, body?: unknown, bearer?: string, key?: string): Request {
  const bodyKey = body && typeof body === 'object' && 'key' in body ? body.key : undefined;
  const requestKey = key ?? (typeof bodyKey === 'string' ? bodyKey : randomUUID());
  return new Request(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body === undefined
        ? {}
        : {
            'content-type': 'application/json',
            'idempotency-key': JSON.stringify(requestKey),
          }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function settleApiRuntime(cleanup: Promise<void>, failure?: ApiRuntimeFailure): Promise<void> {
  try {
    await cleanup;
  } catch (error) {
    if (failure)
      throw new AggregateError([failure.error, error], 'Native importer case and cleanup failed', {
        cause: failure.error,
      });
    throw error;
  }
}

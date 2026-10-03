import { sameOriginWrite } from './same-origin.ts';
import { serverFetch, deadlineFromHeaders, SERVER_READ_LIMITS } from './server-fetch.ts';

export interface DisplayPreferences {
  revision: number;
  displayMode: 'system' | 'light' | 'dark';
  showZoneThemes: boolean;
}

export function parseDisplayPreferences(value: unknown): DisplayPreferences | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(item.revision) ||
    (item.revision as number) < 0 ||
    !['system', 'light', 'dark'].includes(String(item.displayMode)) ||
    typeof item.showZoneThemes !== 'boolean'
  )
    return null;
  return item as unknown as DisplayPreferences;
}

export async function loadDisplayPreferences(
  fetcher: typeof fetch = fetch,
): Promise<DisplayPreferences | null> {
  try {
    const response = await fetcher('/api/preferences', { cache: 'no-store' });
    return response.ok ? parseDisplayPreferences(await response.json()) : null;
  } catch {
    return null;
  }
}

/** A changed control writes the entire account value and retries once after a competing update. */
export async function saveDisplayPreference(
  change: Partial<Pick<DisplayPreferences, 'displayMode' | 'showZoneThemes'>>,
  fetcher: typeof fetch = fetch,
): Promise<'saved' | 'signed-out' | 'failed'> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let current: Response;
    try {
      current = await fetcher('/api/preferences', { cache: 'no-store' });
    } catch {
      return 'failed';
    }
    if (current.status === 401) return 'signed-out';
    const value = current.ok
      ? parseDisplayPreferences(await current.json().catch(() => null))
      : null;
    if (!value) return 'failed';
    let result: Response;
    try {
      result = await fetcher('/api/preferences', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: value.revision,
          displayMode: change.displayMode ?? value.displayMode,
          showZoneThemes: change.showZoneThemes ?? value.showZoneThemes,
        }),
      });
    } catch {
      return 'failed';
    }
    if (result.ok) return 'saved';
    if (result.status !== 409) return 'failed';
  }
  return 'failed';
}

/** Only this fixed Account resource crosses the web session's BFF boundary. */
export async function forwardDisplayPreferences(
  request: Request,
  input: {
    accountOrigin: string;
    accessToken: string | undefined;
    fetch?: typeof fetch;
  },
): Promise<Response> {
  if (!['GET', 'PUT'].includes(request.method))
    return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  if (request.method === 'PUT' && !sameOriginWrite(request)) {
    return Response.json({ error: 'invalid_origin' }, { status: 403 });
  }
  if (!input.accessToken) return Response.json({ error: 'unauthenticated' }, { status: 401 });
  const headers = new Headers({ authorization: `Bearer ${input.accessToken}` });
  if (request.method === 'PUT') {
    headers.set('origin', input.accountOrigin);
    headers.set('content-type', 'application/json');
  }
  let response: Response;
  try {
    response = await serverFetch(
      new URL('/api/account/display-preferences', input.accountOrigin),
      {
        method: request.method,
        headers,
        body: request.method === 'PUT' ? request.body : undefined,
        ...(request.method === 'PUT' && request.body ? { duplex: 'half' } : {}),
        cache: 'no-store',
        redirect: 'manual',
        signal: request.signal,
      } as RequestInit,
      {
        fetch: input.fetch,
        deadlineAt: deadlineFromHeaders(request.headers),
        timeoutMs: SERVER_READ_LIMITS.metadata,
      },
    );
  } catch {
    return Response.json(
      { error: 'temporarily_unavailable' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
  return new Response(response.body, {
    status: response.status,
    headers: {
      'content-type': response.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    },
  });
}

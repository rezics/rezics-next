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

type Change = Partial<Pick<DisplayPreferences, 'displayMode' | 'showZoneThemes'>>;
type Saved = 'saved' | 'signed-out' | 'failed';

/** The choices made while one write was in flight: later ones replace earlier ones per field, and share one outcome. */
interface Round { change: Change; fetcher: typeof fetch; waiting: ((saved: Saved) => void)[] }

let running = false;
let queued: Round | null = null;

const differs = (value: DisplayPreferences, change: Change) =>
  (change.displayMode !== undefined && change.displayMode !== value.displayMode)
  || (change.showZoneThemes !== undefined && change.showZoneThemes !== value.showZoneThemes);

/**
 * Writes the account value for a round's choices. After a competing update (409) the account is read again and only
 * the newest choice per field is applied, and only where it still differs from the account.
 */
async function settleRound(round: Round): Promise<Saved> {
  const { fetcher } = round;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (queued) {
      // Choices made while this one was being written supersede it, and take this round's outcome.
      Object.assign(round.change, queued.change);
      round.waiting.push(...queued.waiting);
      queued = null;
    }
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
    if (!differs(value, round.change)) return 'saved';
    let result: Response;
    try {
      result = await fetcher('/api/preferences', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: value.revision,
          displayMode: round.change.displayMode ?? value.displayMode,
          showZoneThemes: round.change.showZoneThemes ?? value.showZoneThemes,
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

/**
 * A changed control writes the entire account value. One write is in flight at a time: a choice made meanwhile
 * waits for it and is written next, newest per field, so an older response never overwrites a newer choice.
 */
export function saveDisplayPreference(change: Change, fetcher: typeof fetch = fetch): Promise<Saved> {
  return new Promise<Saved>(resolve => {
    queued ??= { change: {}, fetcher, waiting: [] };
    for (const key of ['displayMode', 'showZoneThemes'] as const) {
      if (change[key] !== undefined) Object.assign(queued.change, { [key]: change[key] });
    }
    queued.waiting.push(resolve);
    if (!running) void drain();
  });
}

async function drain(): Promise<void> {
  running = true;
  try {
    while (queued) {
      const round = queued;
      queued = null;
      const saved = await settleRound(round).catch((): Saved => 'failed');
      for (const resolve of round.waiting) resolve(saved);
    }
  } finally {
    running = false;
  }
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

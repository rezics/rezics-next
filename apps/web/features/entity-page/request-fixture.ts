import { spyOn } from 'bun:test';
import { workAsyncStorage, type WorkStore } from 'next/dist/server/app-render/work-async-storage.external.js';
import { workUnitAsyncStorage, type RequestStore } from 'next/dist/server/app-render/work-unit-async-storage.external.js';

// Server reads (`reader()`, the Main client) need a render request. This gives the real next/headers and next/cookies
// adapters one, without replacing a module or leaking a mock into the other suites.

export const actingSubject = 'https://rezics.com/id/01944100-0000-7000-8000-0000000000aa';

/** Run `run` as a page render; `signedIn` adds the access and session cookies the Agent lookup reads. */
export async function pageRequest<T>(run: () => Promise<T>, { signedIn = false } = {}): Promise<T> {
  const headers = new Headers({ 'x-rezics-page-url': 'https://rezics.test/en/discover' });
  const cookies = {
    get: (name: string) =>
      !signedIn ? undefined
        : name === 'rezics_session_key' ? { value: '99800000-0000-4000-8000-000000000002' }
        : name === 'rezics_access' ? { value: 'reader-token' } : undefined,
  };
  const work = spyOn(workAsyncStorage, 'getStore').mockReturnValue({ route: '/en/discover' } as WorkStore);
  const request = spyOn(workUnitAsyncStorage, 'getStore').mockReturnValue({
    type: 'request', phase: 'render', headers, cookies } as RequestStore);
  try { return await run(); } finally { work.mockRestore(); request.mockRestore(); }
}

/** A Main double: `answer` gets each request's URL and parsed JSON body and returns a JSON body or a status. */
export function mainDouble(answer: (url: URL, body: unknown) => unknown | number) {
  const calls: { url: URL; body: unknown }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const text = init?.body ? String(init.body) : input instanceof Request ? await input.clone().text() : '';
    const body = text ? JSON.parse(text) : null;
    if (url.pathname === '/v1/me/session-agent')
      return Response.json({ sessionAgent: { eligible: true, actingSubject } });
    calls.push({ url, body });
    const result = answer(url, body);
    return typeof result === 'number' ? new Response(null, { status: result }) : Response.json(result);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

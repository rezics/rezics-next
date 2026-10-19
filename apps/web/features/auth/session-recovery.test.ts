import { describe, expect, test } from 'bun:test';
import { readMainSessionAgentResult } from './session.ts';
import { resolveSessionAgent, type AgentOption } from './acting-identity.ts';

const testFetch = (handle: (...args: Parameters<typeof fetch>) => Promise<Response>): typeof fetch =>
  Object.assign(handle, { preconnect: fetch.preconnect });

const sessionKey = '01944100-0000-7000-8000-000000000999';
const chosen = 'https://rezics.com/id/01944100-0000-7000-8000-000000000001';
const state = {
  sessionAgent: { actingSubject: chosen, eligible: true, revision: 'saved-revision' },
  mainAgent: { actingSubject: null, eligible: false, revision: null },
  initialActingSubject: null,
};

describe('session identity discovery recovery', () => {
  test('a known saved choice stays unverified on failure and ineligible when Main withdraws it', () => {
    const option: AgentOption = { iri: chosen, label: 'Known Agent', handle: null, kind: 'person', path: null };
    expect(resolveSessionAgent(null, chosen)).toEqual({ status: 'unverified', previous: chosen });
    expect(resolveSessionAgent([option], chosen, false)).toEqual({ status: 'ineligible', previous: chosen });
    expect(resolveSessionAgent(null, chosen, false)).toEqual({ status: 'ineligible', previous: chosen });
    expect(resolveSessionAgent([], null)).toEqual({ status: 'none' });
    expect(resolveSessionAgent([option], null)).toEqual({ status: 'unselected' });
    expect(resolveSessionAgent([option], chosen, true)).toEqual({ status: 'selected', agent: option });
  });
  test('a Main 503 retains its failure and retries the same web session without choosing another Agent', async () => {
    let failed = true;
    const requests: { path: string; key: string | null; token: string | null }[] = [];
    const fetcher = testFetch(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers);
      requests.push({ path: url.pathname, key: headers.get('x-session-key'), token: headers.get('authorization') });
      return failed ? Response.json({ error: 'dependency_unavailable' }, { status: 503 }) : Response.json(state);
    });
    const before = await readMainSessionAgentResult('same-token', sessionKey, fetcher);
    expect(before).toMatchObject({ kind: 'unavailable', status: 503, problem: { error: 'dependency_unavailable' } });
    failed = false;
    expect(await readMainSessionAgentResult('same-token', sessionKey, fetcher)).toEqual({ kind: 'ready', state });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]).toEqual({ path: '/v1/me/session-agent', key: sessionKey, token: 'Bearer same-token' });
  });

  test('denial remains denial and an absent session key cannot become an invented selection', async () => {
    for (const status of [401, 403]) {
      expect(await readMainSessionAgentResult('same-token', sessionKey,
        testFetch(async () => Response.json({ error: 'denied' }, { status })))).toMatchObject({ kind: 'denied', status });
    }
    expect(await readMainSessionAgentResult('same-token', 'invalid', testFetch(async () => {
      throw new Error('No read is authorized without a valid session key');
    }))).toEqual({ kind: 'unselected' });
    expect(await readMainSessionAgentResult('same-token', sessionKey, testFetch(async () => {
      throw new TypeError('Offline');
    }))).toMatchObject({ kind: 'unavailable' });
  });
});

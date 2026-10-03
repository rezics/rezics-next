import { expect, test } from 'bun:test';
import { workProfileCorpusApi } from '../../../scripts/load/work-profile-corpus.ts';

test('G1031: cancelled in-process responses preserve the preparation deadline rather than an empty-JSON error', async () => {
  for (const operation of ['command', 'read'] as const) {
    const controller = new AbortController();
    const reason = new DOMException('Preparation exceeded its deadline', 'TimeoutError');
    let requests = 0;
    const api = workProfileCorpusApi('http://main.local', 'fixture-token', {
      signal: controller.signal,
      fetch: ((_input: string | URL | Request, _init?: RequestInit) => {
        requests++;
        controller.abort(reason);
        return Promise.resolve(new Response(null, { status: 200 }));
      }) as typeof fetch,
    });
    const invoke = () => operation === 'command'
      ? api.command('g1031:deadline', { method: 'POST', path: '/v1/works', body: {} })
      : api.read('/v1/works');
    await expect(invoke()).rejects.toBe(reason);
    await expect(invoke()).rejects.toBe(reason);
    expect(requests).toBe(1);
  }
});

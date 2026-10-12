import { expect, test } from 'bun:test';
import { CorpusCommandError, workProfileCorpusApi } from '../../../scripts/load/work-profile-corpus.ts';

test('corpus refusals retain typed status, code, operation, stage and a bounded body without retrying', async () => {
  for (const detail of [JSON.stringify({ status: 'unavailable', code: 'revision_unavailable', detail: 'x'.repeat(400) }),
    'upstream unavailable', 'null', '']) {
    let requests = 0;
    const api = workProfileCorpusApi('http://main.local', 'fixture', {
      fetch: (() => { requests++; return Promise.resolve(new Response(detail, { status: 503 })); }) as typeof fetch,
    });
    const error = await api.command('corpus:publish', { method: 'POST', path: '/v1/contribution-publications',
      stage: 'medium', body: {} }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CorpusCommandError);
    expect(error).toMatchObject({ status: 503, operation: 'POST /v1/contribution-publications', stage: 'medium',
      body: Buffer.from(detail).subarray(0, 300).toString('utf8') });
    if (detail.startsWith('{')) expect(error).toMatchObject({ code: 'revision_unavailable', responseStatus: 'unavailable' });
    expect((error as Error).message).toContain('stage medium');
    expect(requests).toBe(1);
  }
});

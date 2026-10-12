import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { CorpusCommandError, workProfileCorpusApi, prepareWorkProfileCorpus, CORPUS_REFUSAL_BYTES,
  type WorkProfileCorpusRecipe } from '../../../scripts/load/work-profile-corpus.ts';

test('corpus refusals retain typed status, code, operation, stage and a bounded body without retrying', async () => {
  for (const detail of [JSON.stringify({ status: 'unavailable', code: 'revision_unavailable' }),
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

test('a broken refusal stream retains the known HTTP response and command context', async () => {
  const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('upstream reset')); } });
  const api = workProfileCorpusApi('http://main.local', 'fixture', {
    fetch: (() => Promise.resolve(new Response(body, { status: 503 }))) as typeof fetch,
  });
  const error = await api.command('corpus:publish', { method: 'POST', path: '/v1/contribution-publications',
    stage: 'large', body: {} }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(CorpusCommandError);
  expect(error).toMatchObject({ status: 503, stage: 'large', operation: 'POST /v1/contribution-publications',
    body: 'body unreadable' });
});

test('oversized refusal capture stops at the byte limit, cancels and parses only the excerpt', async () => {
  let bytesRead = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { bytesRead++; controller.enqueue(new Uint8Array([120])); },
    cancel() { cancelled = true; throw new Error('cancel failed'); },
  }, { highWaterMark: 0 });
  const api = workProfileCorpusApi('http://main.local', 'fixture', {
    fetch: (() => Promise.resolve(new Response(body, { status: 503 }))) as typeof fetch,
  });
  const error = await api.command('corpus:publish', { method: 'POST', path: '/v1/contribution-publications',
    body: {} }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(CorpusCommandError);
  expect(error).toMatchObject({ status: 503, body: 'x'.repeat(CORPUS_REFUSAL_BYTES) });
  expect(bytesRead).toBe(CORPUS_REFUSAL_BYTES);
  expect(cancelled).toBe(true);
  const oversized = new CorpusCommandError('key', 'POST /v1/contribution-publications', 'small', 503,
    JSON.stringify({ detail: 'x'.repeat(400), code: 'must-not-parse', status: 'unavailable' }));
  expect(oversized.code).toBeUndefined();
  expect(oversized.responseStatus).toBeUndefined();
  expect(Buffer.byteLength(oversized.body)).toBe(CORPUS_REFUSAL_BYTES);
  const unicode = new CorpusCommandError('key', 'POST /v1/contribution-publications', 'small', 503,
    'x'.repeat(299) + '界');
  expect(Buffer.byteLength(unicode.body)).toBeLessThanOrEqual(CORPUS_REFUSAL_BYTES);
});

test('BUILD preparation propagates its stage to initialization and growth refusals without manual stage', async () => {
  mkdirSync('.temp/corpus-command-stage', { recursive: true });
  for (const scale of ['small', 'medium', 'large'] as const) {
    for (const point of ['initialize', 'grow'] as const) {
      const directory = mkdtempSync('.temp/corpus-command-stage/cut-');
      const fixed = { unrelatedWorks: 0, unrelatedPosts: 0, follows: 0, memberships: 0,
        historyDepth: 0, realmSize: 0, conceptVocabulary: 0 };
      const api = workProfileCorpusApi('http://main.local', 'fixture', {
        fetch: (() => Promise.resolve(new Response('{"status":503,"code":"dependency_unavailable"}',
          { status: 503 }))) as typeof fetch,
      });
      const recipe: WorkProfileCorpusRecipe = { version: 'refusal-stage-v1', fixed,
        async initialize(client, key) {
          if (point === 'initialize') await client.command(key, { method: 'POST', path: '/v1/agents', body: {} });
        },
        async grow(client, _dimension, _index, key) {
          await client.command(key, { method: 'POST', path: '/v1/contribution-publications', body: {} });
        },
        async verify() { throw new Error('refused build cannot verify'); },
      };
      try {
        const error = await prepareWorkProfileCorpus({ recipe, api, dimension: 'unrelatedWorks', scale, directory,
          backups: { async backup() { throw new Error('refused build cannot retain'); }, async restore() {} },
        }).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(CorpusCommandError);
        expect(error).toMatchObject({ stage: scale, status: 503, responseStatus: 503, code: 'dependency_unavailable',
          operation: point === 'initialize' ? 'POST /v1/agents' : 'POST /v1/contribution-publications' });
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }
  }
});

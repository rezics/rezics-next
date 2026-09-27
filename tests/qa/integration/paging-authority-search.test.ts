import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mainSelectionDigest, selectMainDefault }
  from '../../../services/main/src/modules/work/select-main.ts';
import type { SearchContinuation }
  from '../../../services/main/src/modules/work/search-continuation.ts';
import { startMediaStack } from './media-support.ts';

interface Page {
  relationComplete: boolean;
  total: number;
  results: Array<{ work: string }>;
  sourcePosition: { dataEpoch: string; sequence: string };
  indexGeneration: string;
  next: SearchContinuation | null;
}

test('SEARCH16: separate public HTTP pages re-read Jena and restart after Access narrowing, graph movement or a stale index-generation cursor', async () => {
  const stack = await startMediaStack('paging-authority-search');
  try {
    const viewer = await stack.member('viewer');
    const authorA = await stack.member('author-a');
    const authorB = await stack.member('author-b');
    const phrase = `paging${randomUUID().replaceAll('-', '')}`;
    const add = async (actor: string) => {
      const created = await stack.privateWork(actor);
      const source = await stack.contribution(created.work, actor, 'en',
        `${phrase} ${randomUUID()}`);
      const input = { context: { kind: 'main-version-default' as const,
        id: created.mainVersion }, work: created.work,
        contribution: source.contribution, publicationDecision: source.decision,
        expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const,
        actingSubject: actor };
      const selected = await selectMainDefault(stack.env,
        stack.admission(actor, `publication:select:${created.mainVersion}`,
          'publication.select', mainSelectionDigest(input)), input);
      expect(selected.outcome).toBe('succeeded');
      return created.work;
    };
    const a = await add(authorA.actor);
    const b = await add(authorB.actor);
    const c = await add(authorA.actor);
    const request = (continuation?: SearchContinuation) => stack.call('POST', '/v1/queries/page', {
      token: viewer.token, body: { profile: 'public-main-phrase-page-v1', phrase,
        language: 'en', pageSize: 1, continuation },
    });
    const read = async (continuation?: SearchContinuation): Promise<Page> => {
      const response = await request(continuation);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      return response.json() as Promise<Page>;
    };
    const restart = async (continuation: SearchContinuation) => {
      const response = await request(continuation);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'search_restart_required' });
    };

    const initialCalls = stack.fuseki.queries;
    const first = await read();
    const firstCalls = stack.fuseki.queries - initialCalls;
    expect(first).toMatchObject({ relationComplete: true, total: 3 });
    expect(first.next).not.toBeNull();
    const second = await read(first.next!);
    const secondCalls = stack.fuseki.queries - initialCalls - firstCalls;
    expect(second).toMatchObject({ relationComplete: true, total: 3 });
    expect(second.next).not.toBeNull();
    expect(first.results[0]?.work).not.toBe(second.results[0]?.work);
    // Both HTTP requests execute a bounded native read; no TDB2 snapshot crosses them.
    expect(firstCalls).toBeGreaterThan(0);
    expect(secondCalls).toBeGreaterThan(0);
    expect(firstCalls).toBeLessThanOrEqual(12);
    expect(secondCalls).toBeLessThanOrEqual(12);

    const mute = { profile: 'access-interaction-mute-v1', targetKind: 'agent',
      target: authorB.actor, match: 'author', muted: true, expectedRevision: null };
    const mutedResponse = await stack.call('PUT', '/v1/me/interaction-mutes', {
      token: viewer.token, key: randomUUID(), body: mute });
    expect(mutedResponse.status).toBe(200);
    const muted = await mutedResponse.json() as { revision: string };
    await restart(first.next!);
    const narrowed = await read();
    expect(narrowed.total).toBe(2);
    const narrowedSecond = await read(narrowed.next!);
    expect(new Set([...narrowed.results, ...narrowedSecond.results].map(row => row.work)))
      .toEqual(new Set([a, c]));
    expect(JSON.stringify([narrowed, narrowedSecond])).not.toContain(b);

    const unmutedResponse = await stack.call('PUT', '/v1/me/interaction-mutes', {
      token: viewer.token, key: randomUUID(),
      body: { ...mute, muted: false, expectedRevision: muted.revision } });
    expect(unmutedResponse.status).toBe(200);
    // A removed mute restores the current disclosure; the old cursor may be
    // accepted because the visible relation has returned to its prior shape.
    const recovered = await read(first.next!);
    expect(recovered.total).toBe(3);
    const beforeWrite = await read();
    const added = await add(authorA.actor);
    await restart(beforeWrite.next!);
    const afterWrite = await read();
    expect(afterWrite.total).toBe(4);
    expect(BigInt(afterWrite.sourcePosition.sequence))
      .toBeGreaterThan(BigInt(beforeWrite.sourcePosition.sequence));
    const all = [afterWrite];
    while (all.at(-1)?.next) all.push(await read(all.at(-1)!.next!));
    expect(new Set(all.flatMap(page => page.results.map(row => row.work))))
      .toEqual(new Set([a, b, c, added]));

    // A continuation from the previous index generation has the same shape as
    // an operator-rebuilt cursor. The route must restart it after a new read.
    const changedGeneration = { ...afterWrite.next!,
      indexGeneration: `urn:rezics:text-index-generation:${randomUUID()}` };
    await restart(changedGeneration);
  } finally { await stack.stop(); }
}, 120_000);

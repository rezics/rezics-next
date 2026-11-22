import { expect, test } from 'bun:test';
import { withQueryAccounting } from '../../src/database/pool.ts';
import { advanceProjectionCleanupSql } from '../../src/semantic/public-filter-projection-build-write.ts';
import { publicFilterSource } from '../../src/semantic/public-filter-source.ts';
import { retainedPublicFilterProjectionDependenciesCurrent } from '../../src/semantic/public-filter-projection.ts';
import type { PublicFilterProjectionFrontier } from '../../src/semantic/public-filter-source-contract.ts';
import { fixture, readContext, statement } from './support/public-filter-source.ts';

test('a large replaced projection advances bounded head batches and replays the original cleanup frontier', async () => {
  const f = await fixture();
  try {
    const authors: string[] = [];
    for (let index = 0; index < 10; index++) authors.push(await f.create());
    const book = await f.create('schema:Book', {
      'schema:author': authors.map((id) => statement('schema:author', id)),
    });
    const read = (frontier: PublicFilterProjectionFrontier | null, inputLimit = 2) =>
      publicFilterSource(f.config).readPublicFilterProjectionPage({
        subject: book,
        meaning: f.meaning,
        context: readContext(),
        inputLimit,
        frontier,
      });
    let first = await read(null);
    while (first.status === 'progress') first = await read(first.frontier);
    expect(first.status).toBe('complete');
    if (first.status !== 'complete') throw new Error('Missing original projection');
    const prior = first.frontier;
    const heads = async () =>
      Number(
        (
          await f.db.admin.query('SELECT count(*) FROM semantic.public_filter_projection_head WHERE build_id=$1', [
            prior.build,
          ])
        ).rows[0]!.count,
      );
    const before = await heads();
    expect(before).toBeGreaterThan(5);
    const cleanup = await read(null);
    expect(cleanup.status).toBe('progress');
    if (cleanup.status !== 'progress') throw new Error('No replacement frontier');
    expect(cleanup.records).toEqual([]);
    expect(cleanup.frontier.build).not.toBe(prior.build);
    expect(before - (await heads())).toBeGreaterThan(0);
    expect(before - (await heads())).toBeLessThanOrEqual(2);
    const current = (page: typeof cleanup) =>
      retainedPublicFilterProjectionDependenciesCurrent(
        f.db.pool,
        { page, meaning: { digest: f.meaning.digest } },
        readContext(),
      );
    expect(await current(cleanup)).toBe(true);
    const count = await heads();
    const pair = await Promise.all([read(cleanup.frontier, 1), read(cleanup.frontier, 1)]);
    if (pair[0].status !== 'progress' || pair[1].status !== 'progress')
      throw new Error('Concurrent cleanup did not advance');
    expect(pair[0].frontier).toEqual(pair[1].frontier);
    expect(pair[0].source).toEqual(cleanup.source);
    expect(pair[1].source).toEqual(cleanup.source);
    expect(count - (await heads())).toBe(1);
    expect(pair.every((page) => page.cost.inputKeys <= 1)).toBe(true);
    const next = pair[0].frontier;
    const beforeLoss = await heads();
    let advanced = false;
    let acknowledgementLost = false;
    await withQueryAccounting(
      {
        connection: (dispatch) => dispatch(),
        async query(sql, _values, dispatch) {
          const result = await dispatch();
          if (sql === advanceProjectionCleanupSql) advanced = true;
          if (advanced && !acknowledgementLost && sql === 'COMMIT') {
            acknowledgementLost = true;
            throw Object.assign(new Error('Connection lost after committing the retired keys'), { code: 'ECONNRESET' });
          }
          return result;
        },
      },
      () => read(next),
    ).catch(() => undefined);
    expect(acknowledgementLost).toBe(true);
    const committed = await heads();
    expect(beforeLoss - committed).toBeGreaterThan(0);
    expect(beforeLoss - committed).toBeLessThanOrEqual(2);
    let page = await read(next);
    expect(page.status).toBe('progress');
    expect(await heads()).toBe(committed);
    const records: string[] = [];
    let installed: typeof cleanup | undefined;
    for (let step = 0; step < 64 && page.status === 'progress'; step++) {
      const predecessor = page;
      page = await read(predecessor.frontier);
      if (page.status === 'progress' || page.status === 'complete') {
        expect(page.frontier.build).toBe(cleanup.frontier.build);
        records.push(...page.records.map((record) => record.candidate));
        if (page.records.length && !installed) installed = predecessor;
      }
    }
    expect(page.status).toBe('complete');
    expect(new Set(records).size).toBe(10);
    expect(await heads()).toBe(0);
    expect(installed).toBeDefined();
    const replay = await read(cleanup.frontier);
    if (replay.status !== 'progress') throw new Error('Original cleanup acknowledgement was not recoverable');
    expect(replay.frontier).toEqual(pair[0].frontier);
    expect(await current(cleanup)).toBe(true);
    await f.post(`/v1/subjects/${book}:hide`, { reason: 'Reduce the original projection source' });
    expect(await current(cleanup)).toBe(false);
  } finally {
    await f.close();
  }
}, 120_000);

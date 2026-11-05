import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runImportCli } from '../src/cli.ts';
import { CAPTURE_SCAN_WINDOW, CaptureComparison } from '../src/capture-comparison.ts';
import { RunStore, type Run, type SourceProjection } from '../src/run-store.ts';

const temporaryRoot = resolve(import.meta.dir, '../../../.temp');

function digest(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

function temporaryState() {
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(temporaryRoot, 'capture-comparison-'));
  const path = join(directory, 'state.sqlite');
  const database = new Database(path, { create: true, strict: true });
  const store = new RunStore<SourceProjection>(database, { projectionMode: 'source-record' });
  return {
    directory,
    path,
    database,
    store,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function staged(
  source: string,
  key: string,
  options: { revision?: string; digest?: string; converter?: string; title?: string } = {},
) {
  return {
    row: {
      source,
      recordKey: key,
      recordRevision: options.revision ?? 'revision-1',
      digest: options.digest ?? digest(`${source}:${key}:1`),
      converter_revision: options.converter ?? 'test@1',
      state: 'present' as const,
    },
    projection: {
      sourceKind: 'wikidata' as const,
      normalizedRecord: { id: key, title: options.title ?? key, type: 'item' },
    },
  };
}

function vanishedKeys(store: RunStore<SourceProjection>, run: Run): string[] {
  const keys: string[] = [];
  let after: string | undefined;
  while (true) {
    const page = store.pageVanished(run, after === undefined ? { limit: 100 } : { limit: 100, after });
    if (!page.length) break;
    keys.push(...page.map((row) => row.recordKey));
    after = page.at(-1)!.recordKey;
  }
  return keys;
}

function complete(store: RunStore<SourceProjection>, run: Run, present: string[]): void {
  expect(store.seal(run, { complete: true }).status).toBe('ready');
  for (const key of present) {
    store.classify(run, key, { commands: [] });
    store.acknowledgeNoEffects(run, key, { reason: 'no-owned-candidates' });
  }
  for (const key of vanishedKeys(store, run)) {
    store.classify(run, key, { commands: [] });
    store.acknowledgeNoEffects(run, key, { reason: 'no-owned-candidates' });
  }
  while (true) {
    const result = store.finalize(run, 100);
    if (result === 'complete') return;
    if (result === 'incomplete') throw new Error('Generation could not finalize');
  }
}

async function compare(path: string, args: string[]) {
  return runImportCli(['capture-comparison', '--state', path, ...args]);
}

function documentOf(result: { code: number; stdout: string }) {
  expect(result.code, result.stdout + (result as { stderr?: string }).stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    source: string;
    before: { generation: string; status: string; supplied: number };
    after: { generation: string; status: string; supplied: number };
    counts: {
      state: string;
      new?: number;
      changed?: number;
      unchanged?: number;
      vanished?: number;
      presentBefore?: number;
      presentAfter?: number;
      excludedVanishedBefore?: number;
    };
    page: null | {
      kind: string;
      rows: { recordKey: string; category: string; identity: { factors: string[] } | null }[];
      end: string;
      nextCursor?: string;
      scannedRows: number;
      scanWindow: number;
    };
    record: null | {
      recordKey: string;
      category: string;
      found: boolean;
      identity: { factors: string[] } | null;
      projection: { available: boolean; reason?: string; fields?: { name: string }[] };
      nativePublication: string;
    };
    work: { sqliteReads: number; visitedRows: number; comparisonCalls: number; scannedRows: number };
    authority: { transport: string; nativePublication: string };
    presentPopulation: string;
    stagedClassification: string;
  };
}

test('two complete same-source captures compare new changed unchanged vanished and reappeared inputs', async () => {
  const fixture = temporaryState();
  try {
    const source = 'wikidata';
    const first = fixture.store.begin(source);
    if (first === 'busy') throw new Error('first generation');
    for (const key of ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']) fixture.store.stage(first, staged(source, key));
    complete(fixture.store, first, ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']);

    const second = fixture.store.begin(source, { disappearanceThreshold: 1 });
    if (second === 'busy') throw new Error('second generation');
    fixture.store.stage(
      second,
      staged(source, 'Q1', { revision: 'revision-2', digest: digest('Q1:2'), title: 'changed' }),
    );
    fixture.store.stage(second, staged(source, 'Q2'));
    fixture.store.stage(second, staged(source, 'Q3', { converter: 'test@2' }));
    fixture.store.stage(second, staged(source, 'Q6', { digest: digest('Q6:1') }));
    complete(fixture.store, second, ['Q1', 'Q2', 'Q3', 'Q6']);

    const third = fixture.store.begin(source);
    if (third === 'busy') throw new Error('third generation');
    fixture.store.stage(
      third,
      staged(source, 'Q1', { revision: 'revision-2', digest: digest('Q1:2'), title: 'changed' }),
    );
    fixture.store.stage(third, staged(source, 'Q2'));
    fixture.store.stage(third, staged(source, 'Q3', { converter: 'test@2' }));
    fixture.store.stage(third, staged(source, 'Q5'));
    fixture.store.stage(third, staged(source, 'Q6', { digest: digest('Q6:1') }));
    complete(fixture.store, third, ['Q1', 'Q2', 'Q3', 'Q5', 'Q6']);

    const counted = documentOf(
      await compare(fixture.path, [
        '--source',
        source,
        '--before',
        first.id,
        '--after',
        second.id,
        '--counts',
        '--json',
      ]),
    );
    expect(counted.counts).toMatchObject({
      state: 'complete',
      new: 1,
      changed: 2,
      unchanged: 1,
      vanished: 2,
      presentBefore: 5,
      presentAfter: 4,
      excludedVanishedBefore: 0,
      excludedVanishedAfter: 2,
    });
    expect(counted.presentPopulation).toBe('row-json-state-present');
    expect(counted.stagedClassification).toBe('not-a-comparison-result');
    expect(counted.authority.transport).toBe('none');
    expect(counted.work.comparisonCalls).toBeGreaterThan(0);

    const pending = documentOf(
      await compare(fixture.path, ['--source', source, '--before', first.id, '--after', second.id, '--json']),
    );
    expect(pending.counts).toEqual({ state: 'pending' });
    expect(pending.work.scannedRows).toBe(0);

    const changed = documentOf(
      await compare(fixture.path, [
        '--source',
        source,
        '--before',
        first.id,
        '--after',
        second.id,
        '--page',
        'changed',
        '--json',
      ]),
    );
    expect(changed.page?.rows.map((row) => row.recordKey).sort()).toEqual(['Q1', 'Q3']);
    expect(changed.page?.rows.find((row) => row.recordKey === 'Q1')?.identity?.factors).toEqual(
      expect.arrayContaining(['revision', 'digest']),
    );
    expect(changed.page?.rows.find((row) => row.recordKey === 'Q3')?.identity?.factors).toEqual(['converter']);
    expect(changed.counts.state).toBe('pending');

    const vanished = documentOf(
      await compare(fixture.path, [
        '--source',
        source,
        '--before',
        first.id,
        '--after',
        second.id,
        '--page',
        'vanished',
        '--json',
      ]),
    );
    expect(vanished.page?.rows.map((row) => row.recordKey).sort()).toEqual(['Q4', 'Q5']);

    const reappeared = documentOf(
      await compare(fixture.path, [
        '--source',
        source,
        '--before',
        second.id,
        '--after',
        third.id,
        '--counts',
        '--json',
      ]),
    );
    expect(reappeared.counts).toMatchObject({ new: 1, changed: 0, unchanged: 4, vanished: 0, presentAfter: 5 });

    const exact = documentOf(
      await compare(fixture.path, [
        '--source',
        source,
        '--before',
        first.id,
        '--after',
        second.id,
        '--record',
        'Q1',
        '--json',
      ]),
    );
    expect(exact.record).toMatchObject({
      found: true,
      category: 'changed',
      nativePublication: 'independent-of-local-capture',
    });
    expect(exact.record?.projection.available).toBe(true);
    expect(exact.work.sqliteReads).toBeLessThan(20);

    const human = await compare(fixture.path, [
      '--source',
      source,
      '--before',
      first.id,
      '--after',
      second.id,
      '--counts',
    ]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('local journal evidence');
    expect(human.stdout).toContain('nativePublication=independent');
    expect(human.stderr).toBe('');

    const inspect = await runImportCli(['inspect', '--state', fixture.path, '--source', source, '--json']);
    expect(inspect.code).toBe(0);
    expect(JSON.parse(inspect.stdout).generation.status).toBe('complete');
  } finally {
    fixture.close();
  }
});

test('empty complete captures, unavailable states, unsafe paths and corrupt cursors fail closed', async () => {
  const fixture = temporaryState();
  try {
    const empty = fixture.store.begin('wikidata');
    if (empty === 'busy') throw new Error('empty');
    complete(fixture.store, empty, []);
    const emptyDocument = documentOf(
      await compare(fixture.path, [
        '--source',
        'wikidata',
        '--before',
        empty.id,
        '--after',
        empty.id,
        '--counts',
        '--json',
      ]),
    );
    expect(emptyDocument.counts).toMatchObject({
      state: 'complete',
      new: 0,
      changed: 0,
      unchanged: 0,
      vanished: 0,
      presentBefore: 0,
      presentAfter: 0,
    });

    const staging = fixture.store.begin('wikidata');
    if (staging === 'busy') throw new Error('staging');
    const stagingResult = await compare(fixture.path, [
      '--source',
      'wikidata',
      '--before',
      empty.id,
      '--after',
      staging.id,
      '--json',
    ]);
    expect(stagingResult.code).toBe(2);
    expect(JSON.parse(stagingResult.stdout).error).toContain('staging');

    expect(fixture.store.abandon(staging)).toBe('abandoned');
    const abandoned = await compare(fixture.path, [
      '--source',
      'wikidata',
      '--before',
      empty.id,
      '--after',
      staging.id,
      '--json',
    ]);
    expect(abandoned.code).toBe(2);
    expect(JSON.parse(abandoned.stdout).error).toContain('abandoned');

    const unknown = await compare(fixture.path, ['--source', 'openlibrary', '--before', '1', '--after', '2', '--json']);
    expect(unknown.code).toBe(2);
    expect(JSON.parse(unknown.stdout).error).toContain('No source state');

    const missing = await compare(join(fixture.directory, 'missing.sqlite'), [
      '--source',
      'wikidata',
      '--before',
      '1',
      '--after',
      '2',
      '--json',
    ]);
    expect(missing.code).toBe(2);
    expect(JSON.parse(missing.stdout).error).toContain('does not exist');

    const link = join(fixture.directory, 'linked.sqlite');
    symlinkSync(fixture.path, link);
    const refused = await compare(link, ['--source', 'wikidata', '--before', empty.id, '--after', empty.id, '--json']);
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.stdout).error).toContain('symbolic link');

    const corrupt = await compare(fixture.path, [
      '--source',
      'wikidata',
      '--before',
      empty.id,
      '--after',
      empty.id,
      '--page',
      'new',
      '--cursor',
      'not-a-cursor',
      '--json',
    ]);
    expect(corrupt.code).toBe(2);
    expect(JSON.parse(corrupt.stdout).error).toMatch(/malformed|noncanonical/i);

    const cancelled = await runImportCli(
      [
        'capture-comparison',
        '--state',
        fixture.path,
        '--source',
        'wikidata',
        '--before',
        empty.id,
        '--after',
        empty.id,
        '--json',
      ],
      { signal: AbortSignal.abort() },
    );
    expect(cancelled.code).toBe(130);
    expect(JSON.parse(cancelled.stdout).error).toContain('cancelled');
  } finally {
    fixture.close();
  }
});

test('cursors revalidate capture identity, retirement invalidates, and live imports do not retarget', async () => {
  const fixture = temporaryState();
  try {
    const source = 'wikidata';
    const keys = Array.from({ length: 8 }, (_, index) => `Q${String(index).padStart(2, '0')}`);
    const first = fixture.store.begin(source);
    if (first === 'busy') throw new Error('first');
    for (const key of keys) fixture.store.stage(first, staged(source, key));
    complete(fixture.store, first, keys);

    const second = fixture.store.begin(source);
    if (second === 'busy') throw new Error('second');
    for (const key of keys) fixture.store.stage(second, staged(source, key, { converter: 'test@2' }));
    complete(fixture.store, second, keys);

    const firstPage = documentOf(
      await compare(fixture.path, [
        '--source',
        source,
        '--before',
        first.id,
        '--after',
        second.id,
        '--page',
        'changed',
        '--limit',
        '3',
        '--json',
      ]),
    );
    expect(firstPage.page?.rows).toHaveLength(3);
    expect(firstPage.page?.end).toBe('more');
    const cursor = firstPage.page?.nextCursor;
    expect(cursor).toBeTruthy();

    const live = fixture.store.begin(source);
    if (live === 'busy') throw new Error('live');
    fixture.store.stage(live, staged(source, 'Q99'));
    const continued = documentOf(
      await compare(fixture.path, [
        '--source',
        source,
        '--before',
        first.id,
        '--after',
        second.id,
        '--page',
        'changed',
        '--limit',
        '3',
        '--cursor',
        cursor!,
        '--json',
      ]),
    );
    expect(continued.before.generation).toBe(first.id);
    expect(continued.after.generation).toBe(second.id);
    expect(continued.page?.rows).toHaveLength(3);
    expect(continued.page?.rows[0]?.recordKey).not.toBe(firstPage.page?.rows[0]?.recordKey);

    fixture.database
      .query('UPDATE run_generations SET status=? WHERE source=? AND id=?')
      .run('retired', source, first.id);
    const retired = await compare(fixture.path, [
      '--source',
      source,
      '--before',
      first.id,
      '--after',
      second.id,
      '--page',
      'changed',
      '--limit',
      '3',
      '--cursor',
      cursor!,
      '--json',
    ]);
    expect(retired.code).toBe(2);
    expect(JSON.parse(retired.stdout).error).toContain('retired');
  } finally {
    fixture.close();
  }
});

test('legacy projection stays unavailable and incomplete accounting is refused', async () => {
  const fixture = temporaryState();
  try {
    const source = 'wikidata';
    const first = fixture.store.begin(source);
    if (first === 'busy') throw new Error('first');
    fixture.store.stage(first, staged(source, 'Q1'));
    complete(fixture.store, first, ['Q1']);
    const second = fixture.store.begin(source);
    if (second === 'busy') throw new Error('second');
    fixture.store.stage(second, staged(source, 'Q1', { revision: 'revision-2', digest: digest('later') }));
    complete(fixture.store, second, ['Q1']);
    fixture.database
      .query('UPDATE run_entries SET projection_json=? WHERE source=? AND run_id=? AND record_key=?')
      .run('{}', source, first.id, 'Q1');
    const exact = documentOf(
      await compare(fixture.path, [
        '--source',
        source,
        '--before',
        first.id,
        '--after',
        second.id,
        '--record',
        'Q1',
        '--json',
      ]),
    );
    expect(exact.record?.category).toBe('changed');
    expect(exact.record?.projection).toMatchObject({ available: false, reason: 'unsupported-format' });

    fixture.database.query('UPDATE run_generations SET supplied=? WHERE source=? AND id=?').run(99, source, second.id);
    const counted = await compare(fixture.path, [
      '--source',
      source,
      '--before',
      first.id,
      '--after',
      second.id,
      '--counts',
      '--json',
    ]);
    expect(counted.code).toBe(1);
    expect(JSON.parse(counted.stdout).error).toContain('Incomplete capture accounting');
  } finally {
    fixture.close();
  }
});

test('count and paged union agree on 32/128/512 rows including sparse changes and unrelated history', async () => {
  for (const scale of [32, 128, 512]) {
    const fixture = temporaryState();
    try {
      const source = 'wikidata';
      const unrelated = fixture.store.begin('openlibrary');
      if (unrelated === 'busy') throw new Error('unrelated');
      const extra = Array.from({ length: scale }, (_, index) => `OL${index + 1}M`);
      for (const key of extra) fixture.store.stage(unrelated, staged('openlibrary', key, { converter: 'ol@1' }));
      complete(fixture.store, unrelated, extra);

      const beforeKeys = Array.from({ length: scale }, (_, index) => `Q${String(index).padStart(4, '0')}`);
      const first = fixture.store.begin(source);
      if (first === 'busy') throw new Error('first');
      for (const key of beforeKeys) fixture.store.stage(first, staged(source, key));
      complete(fixture.store, first, beforeKeys);

      const vanished = beforeKeys.slice(0, 4);
      const changed = beforeKeys.slice(-4);
      const unchanged = beforeKeys.slice(4, -4);
      const added = Array.from({ length: 4 }, (_, index) => `N${String(index).padStart(4, '0')}`);
      const second = fixture.store.begin(source);
      if (second === 'busy') throw new Error('second');
      for (const key of unchanged) fixture.store.stage(second, staged(source, key));
      for (const key of changed)
        fixture.store.stage(second, staged(source, key, { converter: 'test@2', digest: digest(`${key}:changed`) }));
      for (const key of added) fixture.store.stage(second, staged(source, key, { digest: digest(key) }));
      complete(fixture.store, second, [...unchanged, ...changed, ...added]);

      const queries: string[] = [];
      const comparison = await CaptureComparison.open(fixture.path, { onQuery: (sql) => queries.push(sql) });
      try {
        const counted = comparison.compare({
          source,
          before: first.id,
          after: second.id,
          counts: true,
        });
        expect(counted.counts).toMatchObject({
          state: 'complete',
          new: 4,
          changed: 4,
          unchanged: unchanged.length,
          vanished: 4,
        });
        if (counted.counts.state !== 'complete') throw new Error('counts');
        expect(counted.work.visitedRows).toBeGreaterThanOrEqual(scale);
        expect(counted.work.sqliteReads).toBe(queries.length);
        expect(counted.work.comparisonCalls).toBe(counted.counts.presentBefore + counted.counts.vanished);

        const collected = {
          new: [] as string[],
          changed: [] as string[],
          unchanged: [] as string[],
          vanished: [] as string[],
        };
        for (const kind of ['new', 'changed', 'unchanged', 'vanished'] as const) {
          let cursor: string | undefined;
          let pages = 0;
          while (pages < 64) {
            const page = comparison.compare({
              source,
              before: first.id,
              after: second.id,
              page: kind,
              limit: 20,
              ...(cursor ? { cursor } : {}),
            });
            expect(page.page?.scanWindow).toBe(CAPTURE_SCAN_WINDOW);
            collected[kind].push(...(page.page?.rows.map((row) => row.recordKey) ?? []));
            pages += 1;
            if (page.page?.end === 'end') break;
            expect(page.page?.end).toBe('more');
            cursor = page.page?.nextCursor;
            expect(cursor).toBeTruthy();
            if (kind === 'changed' && pages === 1 && scale >= 128) {
              expect(page.page?.scannedRows).toBeLessThanOrEqual(CAPTURE_SCAN_WINDOW);
            }
          }
        }
        expect(collected.new).toEqual([...added].sort());
        expect(collected.changed.sort()).toEqual([...changed].sort());
        expect(collected.vanished.sort()).toEqual([...vanished].sort());
        expect(collected.unchanged).toHaveLength(unchanged.length);
        expect(
          collected.new.length + collected.changed.length + collected.unchanged.length + collected.vanished.length,
        ).toBe(counted.counts.new + counted.counts.changed + counted.counts.unchanged + counted.counts.vanished);

        const exact = comparison.compare({ source, before: first.id, after: second.id, record: changed[0]! });
        expect(exact.record?.category).toBe('changed');
        expect(exact.work.sqliteReads).toBeLessThan(counted.work.sqliteReads);
      } finally {
        await comparison.close();
      }
    } finally {
      fixture.close();
    }
  }
});

test('control characters are escaped and inspect/compare routing is unchanged', async () => {
  const fixture = temporaryState();
  try {
    const help = await runImportCli(['--help', 'capture-comparison']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Generation IDs are exact decimal text');
    const inspectHelp = await runImportCli(['inspect', '--help']);
    expect(inspectHelp.code).toBe(0);
    expect(inspectHelp.stdout).toContain('inspect');
    const compareHelp = await runImportCli(['compare', '--help']);
    expect(compareHelp.code).toBe(0);
    expect(compareHelp.stdout).toContain('preview-dir');

    writeFileSync(join(fixture.directory, 'not-sqlite'), 'not a database');
    const broken = await compare(join(fixture.directory, 'not-sqlite'), [
      '--source',
      'wikidata',
      '--before',
      '1',
      '--after',
      '2',
    ]);
    expect(broken.code).toBe(2);
    expect(broken.stderr).not.toMatch(/\u001b/);
  } finally {
    fixture.close();
  }
});

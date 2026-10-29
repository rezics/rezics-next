import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { checkBatchWrite } from '@rezics/definitions/bulk';
import {
  type CountedCheck,
  countedSample,
  countedViolations,
} from '../services/kernel/test/support/growth-counters.ts';
import {
  loadVndbTablesDriver,
  limits,
  type Cost,
  type Entry,
  type Path,
  type VndbTablesDriver,
} from './imports-vndb-tables-driver.ts';

const names = ['vn.header', 'vn', 'vn_titles.header', 'vn_titles', 'entry_meta.header', 'entry_meta'];
const encode = (value: string) => new TextEncoder().encode(value);
function entry(path: string, value: string | Uint8Array, chunk = 1): Entry {
  const bytes = typeof value === 'string' ? encode(value) : value;
  return {
    path,
    kind: 'file',
    declaredBytes: bytes.length,
    bytes: (async function* () {
      for (let i = 0; i < bytes.length; i += chunk) yield bytes.subarray(i, i + chunk);
    })(),
  };
}
const text = (name: string) =>
  readFileSync(new URL(`./fixtures/imports/vndb-tables/db/${name}`, import.meta.url), 'utf8');
const fixture = () => names.map((name) => entry(`db/${name}`, text(name)));
const replace = (entries: Entry[], path: string, value: string | Uint8Array) =>
  entries.map((item) => (item.path === path ? entry(path, value) : item));
async function* stream(entries: Entry[]) {
  for (const item of entries) {
    let consumed = 0;
    let passes = 0;
    const bytes: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        expect(++passes).toBe(1);
        for await (const chunk of item.bytes) {
          consumed += chunk.byteLength;
          yield chunk;
        }
      },
    };
    yield { ...item, bytes };
    // Ignored private tables need not be decoded or consumed. Supported files
    // are streamed exactly once, separately from indexed storage comparisons.
    if (names.some((name) => item.path === `db/${name}`)) {
      expect(passes).toBe(1);
      expect(consumed).toBe(item.declaredBytes);
    }
  }
}
async function stage(d: VndbTablesDriver, entries = fixture()) {
  const run = await d.begin();
  await d.stage(run, stream(entries));
  return run;
}
function at(root: unknown, path: Path): unknown {
  let value = root;
  for (const part of path) {
    expect(value !== null && typeof value === 'object').toBe(true);
    expect(Object.hasOwn(value as object, part)).toBe(true);
    value = (value as Record<string | number, unknown>)[part];
  }
  return value;
}
function converted(d: VndbTablesDriver, row: Awaited<ReturnType<VndbTablesDriver['page']>>['records'][number]) {
  expect(row.key).toBe(row.record.vn.id);
  expect(row.record.vn).toEqual({ id: row.key, olang: expect.any(String) });
  expect(row.revision).toBe(row.record.entry_meta.revision);
  expect(row.output).toEqual(d.converter.convert(row.record));
  const located = d.converter.locate(row.output);
  expect(d.converter.converter_revision.trim()).not.toBe('');
  expect(at(row.output, located.converterRevision)).toBe(d.converter.converter_revision);
  // Table materialization has no API-resolved subject. Observe the actual
  // bootstrap create directly; statement/citation checks use explicit targets
  // in the pure VNDB suite.
  expect(located.proposals).toHaveLength(1);
  expect(checkBatchWrite({ commands: located.proposals.map((path) => at(row.output, path)) })).toEqual([]);
  for (const path of Object.values(located.sourceRights)) {
    for (const proposalPath of located.proposals) {
      expect(proposalPath.every((part, i) => path[i] === part)).toBe(false);
    }
  }
  expect(at(row.output, located.sourceRights.databaseLicense)).toBe('ODbL-1.0');
  expect(at(row.output, located.sourceRights.contentsLicense)).toBe('LicenseRef-DbCL-1.0');
  expect(at(row.output, located.sourceRights.attribution)).toBe('VNDB');
  const proposal = at(row.output, located.proposals[0]!);
  const accepted = d.converter.parseProposal(proposal);
  expect<unknown>(accepted).toEqual(proposal);
  expect(accepted.op).toBe('create');
  if (accepted.op !== 'create') throw new Error('Expected unresolved bootstrap create');
  expect(accepted).not.toHaveProperty('rights');
  expect<unknown>(accepted.source).toEqual({
    source: 'vndb',
    external_id: row.key,
    record_revision: String(row.revision),
    field_group: 'facts',
    digest: at(row.output, ['digest']),
    converter_revision: d.converter.converter_revision,
  });
  expect(accepted.source.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(accepted.subject.type).toBe('wd:Q689445');
  expect(Object.keys(accepted.subject.labels).length).toBeGreaterThan(0);
  expect(accepted.subject).not.toHaveProperty('statements');
  expect(
    Object.keys(accepted.subject).every((key) => ['type', 'labels', 'aliases', 'descriptions'].includes(key)),
  ).toBe(true);
  expect(accepted.subject.descriptions ?? {}).toEqual({});
  // Compare allowed values without prescribing which title becomes the label.
  // Native VN aliases and descriptions are outside the converter's allowlist.
  const titles = new Set<string>();
  for (const title of row.record.vn_titles) {
    titles.add(JSON.stringify([title.lang, title.title]));
    if (title.latin !== null) titles.add(JSON.stringify([`${title.lang}-Latn`, title.latin]));
  }
  const initialTitles = new Set<string>();
  for (const [language, value] of Object.entries(accepted.subject.labels)) {
    initialTitles.add(JSON.stringify([language, value]));
  }
  for (const [language, values] of Object.entries(accepted.subject.aliases ?? {})) {
    for (const value of values) initialTitles.add(JSON.stringify([language, value]));
  }
  expect(initialTitles).toEqual(titles);
  for (const marker of ['UNLICENSED_DESCRIPTION_SENTINEL', 'cv123', 'PRIVATE_SENTINEL']) {
    expect(JSON.stringify(row.output)).not.toContain(marker);
  }
}
function validCost(cost: Cost) {
  for (const value of Object.values(cost)) {
    expect(Number.isSafeInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }
  expect(cost.statements).toBeGreaterThan(0);
  expect(cost.crossPartitionStatements).toBe(0);
  expect(cost.peakBufferedRows).toBeLessThanOrEqual(limits.pageSize * (limits.childRowsPerVn + 2));
}
function bounded(cost: Cost, m: number) {
  validCost(cost);
  expect(cost.statements).toBeLessThanOrEqual(16);
  expect(cost.rows).toBeGreaterThanOrEqual(2 + m);
  expect(cost.rows).toBeLessThanOrEqual(4 * (1 + m));
  expect(cost.rowWrites).toBe(0);
}
function boundedStage(cost: Cost, rows: number) {
  validCost(cost);
  expect(cost.rowWrites).toBe(rows);
  expect(cost.statements).toBeLessThanOrEqual(8 * rows + 16);
  expect(cost.rows).toBeLessThanOrEqual(8 * rows + 16);
}
const sqliteCounts: CountedCheck<Cost> = {
  read: (cost) => ({ 'sqlite returned rows': cost.rows, 'sqlite statements': cost.statements }),
  bounds: { 'sqlite returned rows': 'constant', 'sqlite statements': 'constant' },
  slack: {
    'sqlite returned rows': { absolute: 2, relative: 0.1 },
    'sqlite statements': { absolute: 0, relative: 0 },
  },
};
function sample(scale: number, cost: Cost) {
  return { scale, counted: countedSample([sqliteCounts.read(cost, scale)]) };
}
async function rejected(d: VndbTablesDriver, entries: Entry[]) {
  const before = await Promise.all(['v123', 'v124'].map((key) => d.baseline(key)));
  const run = await d.begin();
  await expect(d.stage(run, stream(entries))).rejects.toThrow();
  expect((await d.inspect(run)).state).toBe('failed');
  expect((await d.inspect(run)).proposalEmissions).toBe(0);
  expect((await d.inspect(run)).publishedProposals).toBe(0);
  expect((await d.inspect(run)).externalRequests).toEqual([]);
  await expect(d.page(run, null, 1)).rejects.toThrow();
  await expect(d.commit(run)).rejects.toThrow();
  await d.reopen();
  expect(await Promise.all(['v123', 'v124'].map((key) => d.baseline(key)))).toEqual(before);
}

test('the actual VNDB table-file format is grouped into complete source records before conversion', async () => {
  const d = await loadVndbTablesDriver();
  try {
    const run = await stage(d);
    expect(await d.inspect(run)).toMatchObject({
      state: 'ready',
      sourceRecords: 2,
      stagedRows: 7,
      proposalEmissions: 0,
      publishedProposals: 0,
      externalRequests: [],
    });
    const first = await d.page(run, null, 1);
    expect(first.records).toHaveLength(1);
    expect(first.next).toBe('v123');
    const row = first.records[0]!;
    expect(Object.keys(row.record).sort()).toEqual(['entry_meta', 'vn', 'vn_titles']);
    expect(row.record.vn).toEqual({ id: 'v123', olang: 'en' });
    expect(await d.retainedMarkers(['UNLICENSED_DESCRIPTION_SENTINEL', 'cv123', 'Harbor Sentinel'])).toEqual([]);
    expect(row.record.vn_titles).toEqual(
      expect.arrayContaining([
        { id: 'v123', lang: 'en', official: true, title: 'Sentinel Harbor', latin: null },
        { id: 'v123', lang: 'de', official: true, title: 'Harbor German Edition', latin: null },
      ]),
    );
    expect(row.record.vn_titles).toHaveLength(2);
    expect(row.record.entry_meta).toEqual({
      id: 'v123',
      created: '2020-01-01',
      lastmod: '2026-10-24',
      revision: 7,
      num_edits: 6,
      num_users: 3,
    });
    converted(d, row);
    const second = await d.page(run, first.next, 1);
    expect(second.records).toHaveLength(1);
    expect(second.next).toBeNull();
    expect(second.records[0]!.key).toBe('v124');
    expect(second.records[0]!.revision).toBe(19);
    expect(second.records[0]!.record.vn_titles[0]!.title).toBe('港の物語');
    converted(d, second.records[0]!);
  } finally {
    await d.close();
  }
});

test('tables and headers may arrive in any order and reopen reads durable grouped rows', async () => {
  const d = await loadVndbTablesDriver();
  try {
    let entries = replace(fixture(), 'db/vn_titles.header', 'title\tlatin\tid\tofficial\tlang\n');
    entries = replace(
      entries,
      'db/vn_titles',
      'Sentinel Harbor\t\\N\tv123\tt\ten\nHarbor German Edition\t\\N\tv123\tt\tde\n港の物語\tMinato no Monogatari\tv124\tt\tja\n',
    );
    entries.push({ ...entry('db/', ''), kind: 'directory' });
    const run = await stage(d, entries.reverse());
    const before = await d.page(run, null, 2);
    await d.commit(run);
    await d.reopen();
    expect(await d.page(run, null, 2)).toEqual(before);
    for (const row of before.records) converted(d, row);
    const baseline = await d.baseline('v123');
    expect(baseline).toMatchObject({ run, revision: 7, converterRevision: d.converter.converter_revision });
    expect(baseline!.digest.length).toBeGreaterThan(0);
  } finally {
    await d.close();
  }
});

test('COPY escapes nulls booleans numeric cells and split UTF8 decode before conversion', async () => {
  const d = await loadVndbTablesDriver();
  try {
    const entries = replace(
      fixture(),
      'db/vn_titles',
      'v123\ten\tt\tHarbor\\tLine\\nEnd\\rPath\\\\Port\\141\\x62港\t\\N\nv123\tde\tf\tGerman\t\\\\N\nv124\tja\tt\t港の物語\t\n',
    );
    const run = await stage(d, entries);
    const row = (await d.page(run, null, 1)).records[0]!;
    expect(row.record.vn_titles.find((t) => t.lang === 'en')).toEqual({
      id: 'v123',
      lang: 'en',
      official: true,
      title: 'Harbor\tLine\nEnd\rPath\\Portab港',
      latin: null,
    });
    expect(row.record.vn_titles.find((t) => t.lang === 'de')).toEqual({
      id: 'v123',
      lang: 'de',
      official: false,
      title: 'German',
      latin: '\\N',
    });
    expect(row.record.entry_meta.revision).toBe(7);
    expect(row.record.vn).not.toHaveProperty('c_length');
    expect((await d.page(run, 'v123', 1)).records[0]!.record.vn_titles[0]!.latin).toBe('');
  } finally {
    await d.close();
  }
});

test('changed raw title and entry revision reach the real converter and committed digest', async () => {
  const d = await loadVndbTablesDriver();
  try {
    const original = await stage(d);
    await d.commit(original);
    const before = await d.baseline('v123');
    let entries = replace(fixture(), 'db/vn_titles', text('vn_titles').replace('Sentinel Harbor', 'Changed Harbor'));
    entries = replace(entries, 'db/entry_meta', text('entry_meta').replace('\t7\t6\t3', '\t8\t7\t3'));
    const changed = await stage(d, entries);
    const row = (await d.page(changed, null, 1)).records[0]!;
    expect(row.revision).toBe(8);
    expect(row.record.vn_titles.find((t) => t.lang === 'en')!.title).toBe('Changed Harbor');
    converted(d, row);
    await d.commit(changed);
    expect((await d.baseline('v123'))!.revision).toBe(8);
    expect((await d.baseline('v123'))!.digest).not.toBe(before!.digest);
  } finally {
    await d.close();
  }
});

test('normalization ignores unsupported public descriptions and images while titles and revisions affect conversion', async () => {
  const d = await loadVndbTablesDriver();
  try {
    const original = await stage(d);
    const before = (await d.page(original, null, 1)).records[0]!;
    converted(d, before);
    await d.commit(original);
    const baseline = await d.baseline('v123');
    const ignored = replace(
      fixture(),
      'db/vn',
      text('vn').replaceAll('UNLICENSED_DESCRIPTION_SENTINEL', 'OTHER_UNLICENSED_PROSE').replaceAll('cv123', 'cv456'),
    );
    const normalized = await stage(d, ignored);
    await d.reopen();
    const unchanged = (await d.page(normalized, null, 1)).records[0]!;
    expect(unchanged.record).toEqual(before.record);
    expect(unchanged.output).toEqual(before.output);
    converted(d, unchanged);
    expect(
      await d.retainedMarkers(['UNLICENSED_DESCRIPTION_SENTINEL', 'OTHER_UNLICENSED_PROSE', 'cv123', 'cv456']),
    ).toEqual([]);
    await d.commit(normalized);
    expect((await d.baseline('v123'))!.digest).toBe(baseline!.digest);
    for (const [table, from, to] of [
      ['vn_titles', 'Sentinel Harbor', 'Changed Harbor'],
      ['entry_meta', '\t7\t6\t3', '\t8\t6\t3'],
    ] as const) {
      const run = await stage(d, replace(fixture(), `db/${table}`, text(table).replace(from, to)));
      const row = (await d.page(run, null, 1)).records[0]!;
      converted(d, row);
      expect(at(row.output, ['digest'])).not.toBe(at(before.output, ['digest']));
      const proposals = (output: unknown) => d.converter.locate(output).proposals.map((path) => at(output, path));
      expect(proposals(row.output)).not.toEqual(proposals(before.output));
      await d.commit(run);
      expect((await d.baseline('v123'))!.digest).not.toBe(baseline!.digest);
    }
  } finally {
    await d.close();
  }
});

test('all required tables validate before the first proposal and a failed source cannot replace the baseline', async () => {
  const d = await loadVndbTablesDriver();
  let release!: () => void;
  let pending: Promise<void> | undefined;
  try {
    const committed = await stage(d);
    await d.commit(committed);
    const before = await d.baseline('v123');
    const run = await d.begin();
    let arrived!: () => void;
    const waiting = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    pending = d.stage(
      run,
      (async function* () {
        yield* fixture();
        arrived();
        await gate;
        yield entry('db/entry_meta', text('entry_meta')); // Late duplicate invalidates the whole source.
      })(),
    );
    await waiting;
    expect((await d.inspect(run)).state).toBe('staging');
    expect((await d.inspect(run)).proposalEmissions).toBe(0);
    expect((await d.inspect(run)).publishedProposals).toBe(0);
    await expect(d.page(run, null, 1)).rejects.toThrow();
    await expect(d.commit(run)).rejects.toThrow();
    release();
    await expect(pending).rejects.toThrow();
    expect((await d.inspect(run)).state).toBe('failed');
    await d.reopen();
    expect(await d.baseline('v123')).toEqual(before);
  } finally {
    release?.();
    await pending?.catch(() => {});
    await d.close();
  }
});

test('duplicate table column and primary keys abort rather than overwrite or disappear', async () => {
  const d = await loadVndbTablesDriver();
  try {
    await d.commit(await stage(d));
    for (const table of ['vn', 'vn_titles', 'entry_meta']) {
      await rejected(d, [...fixture(), entry(`db/${table}`, text(table))]);
      await rejected(d, [...fixture(), entry(`db/${table}.header`, text(`${table}.header`))]);
      await rejected(d, replace(fixture(), `db/${table}`, text(table) + text(table)));
    }
    await rejected(d, replace(fixture(), 'db/vn_titles.header', 'id\tlang\tofficial\ttitle\tid\n'));
  } finally {
    await d.close();
  }
});

test('missing required tables headers titles metadata and mismatched ids abort without API fallback', async () => {
  const d = await loadVndbTablesDriver();
  try {
    await d.commit(await stage(d));
    for (const name of names)
      await rejected(
        d,
        fixture().filter((item) => item.path !== `db/${name}`),
      );
    for (const table of ['vn_titles', 'entry_meta']) {
      await rejected(
        d,
        replace(
          fixture(),
          `db/${table}`,
          text(table)
            .split('\n')
            .filter((row) => !row.startsWith('v124\t'))
            .join('\n'),
        ),
      );
      await rejected(d, replace(fixture(), `db/${table}`, text(table).replaceAll('v124', 'v999')));
    }
    await rejected(d, replace(fixture(), 'db/vn', text('vn').replaceAll('v123', 'r123')));
  } finally {
    await d.close();
  }
});

test('malformed COPY cells headers truncation and invalid UTF8 abort atomically', async () => {
  const d = await loadVndbTablesDriver();
  try {
    await d.commit(await stage(d));
    for (const bytes of [
      text('vn_titles').slice(0, -1),
      text('vn_titles') + 'v125\ten\tt\tcut\\',
      text('vn_titles').replace('\tt\t', '\tmaybe\t'),
      text('vn_titles').replace('Sentinel Harbor', '\\N'),
      'v123\ten\tt\n',
      'v123\ten\tt\tTitle\t\\N\textra\n',
    ]) {
      await rejected(d, replace(fixture(), 'db/vn_titles', bytes));
    }
    for (const revision of ['7x', 'NaN', '32768', '\\N']) {
      await rejected(d, replace(fixture(), 'db/entry_meta', text('entry_meta').replace('\t7\t', `\t${revision}\t`)));
    }
    await rejected(d, replace(fixture(), 'db/vn_titles.header', 'id\tlang\tofficial\tfictional_title\tlatin\n'));
    // Discarding known columns does not exempt their headers or values from validation.
    await rejected(d, replace(fixture(), 'db/vn.header', text('vn.header').replace('description', 'unknown_prose')));
    for (const value of ['bad', '\\N']) {
      await rejected(d, replace(fixture(), 'db/vn', text('vn').replace('\t2\t700\t', `\t${value}\t700\t`)));
    }
    const [prefix, suffix] = text('vn_titles').split('Sentinel Harbor');
    await rejected(
      d,
      replace(fixture(), 'db/vn_titles', new Uint8Array([...encode(prefix!), 0xc3, 0x28, ...encode(suffix!)])),
    );
    const truncated = fixture();
    truncated.find((item) => item.path === 'db/vn')!.declaredBytes += 1;
    await rejected(d, truncated);
    const interrupted = fixture();
    interrupted.find((item) => item.path === 'db/vn')!.bytes = (async function* () {
      yield encode('v123\t');
      throw new Error('Interrupted entry');
    })();
    await rejected(d, interrupted);
  } finally {
    await d.close();
  }
});

test('unsafe archive paths links and normalized aliases abort before any publication', async () => {
  const d = await loadVndbTablesDriver();
  try {
    await d.commit(await stage(d));
    for (const path of ['../vn', '/db/vn', 'db/../vn', 'db/./vn', 'db//vn', 'db\\vn', 'C:\\db\\vn', 'db/vn\0']) {
      await rejected(d, [...fixture(), entry(path, 'PRIVATE_SENTINEL')]);
    }
    for (const kind of ['symlink', 'hardlink'] as const) {
      await rejected(d, [...fixture(), { ...entry('db/link', ''), kind, linkTarget: '../outside' }]);
    }
  } finally {
    await d.close();
  }
});

test('unrelated user post review list tables and shipped SQL are never staged decoded or executed', async () => {
  const d = await loadVndbTablesDriver();
  try {
    const markers = [
      'ACCOUNT_PRIVATE_SENTINEL',
      'POST_PRIVATE_SENTINEL',
      'REVIEW_PRIVATE_SENTINEL',
      'LIST_PRIVATE_SENTINEL',
    ];
    const ignored = ['users', 'threads_posts', 'reviews', 'ulist_vns', 'anime'];
    // entry_meta legitimately includes non-VN entries; they need no matching vn.
    const entries = replace(
      fixture(),
      'db/entry_meta',
      text('entry_meta') + 'r456\t2020-01-01\t2026-10-25\t23\t22\t4\n',
    );
    for (let i = 0; i < ignored.length; i++) {
      entries.push(entry(`db/${ignored[i]}.header`, 'id\tusername\n'));
      entries.push(
        entry(`db/${ignored[i]}`, new Uint8Array([...encode((markers[i % markers.length]! + '\n').repeat(64)), 0xff])),
      );
    }
    for (const name of ['import.sql', 'schema.sql', 'schema_plain.sql', 'schema_vndbid.sql']) {
      entries.push(entry(name, 'SELECT pg_sleep(999); DROP TABLE vn; -- PRIVATE_SENTINEL\n'));
    }
    const run = await stage(d, entries);
    await d.reopen();
    const state = await d.inspect(run);
    expect(state.retainedTables.sort()).toEqual(['entry_meta', 'vn', 'vn_titles']);
    expect(state.stagedRows).toBe(7);
    expect(state.sourceRecords).toBe(2);
    expect(state.executedDumpStatements).toBe(0);
    expect(state.externalRequests).toEqual([]);
    expect(await d.retainedMarkers([...markers, 'PRIVATE_SENTINEL', 'UNLICENSED_DESCRIPTION_SENTINEL'])).toEqual([]);
    for (const row of (await d.page(run, null, 2)).records) converted(d, row);
  } finally {
    await d.close();
  }
});

test('keyset enumeration enforces the fixed page cap and emits each VN exactly once', async () => {
  const d = await loadVndbTablesDriver();
  try {
    let vn = '',
      titles = '',
      meta = '';
    const keys = Array.from({ length: limits.pageSize * 12 + 1 }, (_, i) => `v${1000 + i}`);
    for (const id of keys) {
      vn += `${id}\t\\N\t\\N\ten\t0\t\\N\t\\N\t\\N\t0\t0\t0\t\t\n`;
      titles += `${id}\ten\tt\tTitle ${id}\t\\N\n`;
      meta += `${id}\t2020-01-01\t2026-10-25\t1\t0\t0\n`;
    }
    let entries = replace(fixture(), 'db/vn', vn);
    entries = replace(entries, 'db/vn_titles', titles);
    entries = replace(entries, 'db/entry_meta', meta);
    const run = await d.begin();
    const staged = await d.measure(() => d.stage(run, stream(entries)));
    boundedStage(staged.cost, keys.length * 3);
    await expect(d.page(run, null, limits.pageSize + 1)).rejects.toThrow();
    const seen: string[] = [];
    let after: string | null = null;
    for (let i = 0; i < 13; i++) {
      const measured = await d.measure(() => d.page(run, after, limits.pageSize));
      const page = measured.value;
      expect(page.records).toHaveLength(i === 12 ? 1 : 16);
      expect(measured.cost.rows).toBeLessThanOrEqual(4 * limits.pageSize * 2);
      expect(measured.cost.peakBufferedRows).toBeLessThanOrEqual(160);
      seen.push(...page.records.map((row) => row.key));
      after = page.next;
      expect(after).toBe(i === 12 ? null : page.records.at(-1)!.key);
    }
    expect(seen).toEqual(keys);
  } finally {
    await d.close();
  }
});

test('one grouped record uses indexed seeks and constant returned rows and statements at 32 128 and 512 unrelated keys', async () => {
  const costs: ReturnType<typeof sample>[] = [];
  const staging: ReturnType<typeof sample>[] = [];
  const storage: Array<{ rows: number; bytes: number }> = [];
  for (const scale of [32, 128, 512]) {
    const d = await loadVndbTablesDriver();
    try {
      await d.seed({ unrelatedKeys: scale, historicalActivity: scale * 4 });
      const entries = fixture();
      const inputBytes = entries.reduce((sum, item) => sum + item.declaredBytes, 0);
      const run = await d.begin();
      const staged = await d.measure(() => d.stage(run, stream(entries)));
      boundedStage(staged.cost, 7);
      staging.push(sample(scale, staged.cost));
      const state = await d.inspect(run);
      expect(state.stagedRows).toBe(7);
      expect(state.stagedBytes).toBeGreaterThan(0);
      expect(state.stagedBytes).toBeLessThanOrEqual(8 * inputBytes + 4096);
      storage.push({ rows: state.stagedRows, bytes: state.stagedBytes });
      await d.reopen();
      const measured = await d.measure(() => d.page(run, null, 1));
      expect(measured.value.records).toHaveLength(1);
      expect(measured.value.records[0]!.key).toBe('v123');
      expect(measured.value.records[0]!.revision).toBe(7);
      expect(measured.value.records[0]!.record.vn_titles).toHaveLength(2);
      bounded(measured.cost, 2);
      costs.push(sample(scale, measured.cost));
    } finally {
      await d.close();
    }
  }
  expect(storage[1]).toEqual(storage[0]);
  expect(storage[2]).toEqual(storage[0]);
  expect(countedViolations(sqliteCounts, costs)).toEqual([]);
  expect(countedViolations(sqliteCounts, staging)).toEqual([]);
});

test('supported child cardinality grows only with supplied rows through the hard cap and rejects above it', async () => {
  const d = await loadVndbTablesDriver();
  try {
    await d.seed({ unrelatedKeys: 512, historicalActivity: 2048 });
    const languages = ['en', 'de', 'ja', 'fr', 'es', 'it', 'ru', 'ko', 'pl'];
    for (const m of [2, 4, 8, 9]) {
      const titles =
        languages
          .slice(0, m)
          .map((lang) => `v123\t${lang}\tt\tTitle ${lang}\t\\N\n`)
          .join('') + 'v124\tja\tt\t港の物語\t\\N\n';
      const entries = replace(fixture(), 'db/vn_titles', titles);
      if (m > limits.childRowsPerVn) {
        await rejected(d, entries);
        continue;
      }
      const run = await d.begin();
      const staged = await d.measure(() => d.stage(run, stream(entries)));
      boundedStage(staged.cost, m + 5);
      expect((await d.inspect(run)).stagedRows).toBe(m + 5);
      expect((await d.inspect(run)).stagedBytes).toBeLessThanOrEqual(
        8 * entries.reduce((sum, item) => sum + item.declaredBytes, 0) + 4096,
      );
      const measured = await d.measure(() => d.page(run, null, 1));
      expect(measured.value.records[0]!.record.vn_titles).toHaveLength(m);
      bounded(measured.cost, m);
      await d.commit(run);
    }
  } finally {
    await d.close();
  }
});

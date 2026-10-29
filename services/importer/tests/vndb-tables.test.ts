import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sqliteEvidence, type Entry } from '../../../specs/imports-vndb-tables-driver.ts';
import { countedSample, countedViolations, type CountedCheck } from '../../kernel/test/support/growth-counters.ts';
import { VndbTablesStore } from '../src/vndb-tables.ts';

// Official COPY format evidence and hashes are recorded in the immutable driver above.
const names = ['vn.header', 'vn', 'vn_titles.header', 'vn_titles', 'entry_meta.header', 'entry_meta'];
const source = 'vndb';
const encode = (value: string) => new TextEncoder().encode(value);
type SqliteCounts = ReturnType<ReturnType<typeof sqliteEvidence>['finish']>;
type Sample = { scale: number; counted: ReturnType<typeof countedSample> };
const fixedCheck: CountedCheck = {
  read: (value) => {
    const raw = value as SqliteCounts;
    return { 'sqlite returned rows': raw.rows, 'sqlite statements': raw.statements };
  },
  bounds: { 'sqlite returned rows': 'constant', 'sqlite statements': 'constant' },
  slack: {
    'sqlite returned rows': { absolute: 2, relative: 0.1 },
    'sqlite statements': { absolute: 0, relative: 0 },
  },
};
const stageCheck: CountedCheck = {
  ...fixedCheck,
  bounds: { 'sqlite returned rows': 'linear', 'sqlite statements': 'linear' },
};
const payloadCheck: CountedCheck = {
  ...fixedCheck,
  bounds: { 'sqlite returned rows': 'linear', 'sqlite statements': 'constant' },
};
const text = (name: string) =>
  readFileSync(new URL(`../../../specs/fixtures/imports/vndb-tables/db/${name}`, import.meta.url), 'utf8');
function entry(path: string, value: string | Uint8Array, chunk = 2): Entry {
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
const fixture = () => names.map((name) => entry(`db/${name}`, text(name)));
const replace = (entries: Entry[], path: string, value: string | Uint8Array) =>
  entries.map((item) => (item.path === path ? entry(path, value) : item));
async function* stream(entries: Entry[]) {
  for (const item of entries) {
    let passes = 0;
    let consumed = 0;
    yield {
      ...item,
      bytes: {
        async *[Symbol.asyncIterator]() {
          expect(++passes).toBe(1);
          for await (const bytes of item.bytes) {
            consumed += bytes.length;
            yield bytes;
          }
        },
      },
    };
    expect(passes).toBe(1);
    expect(consumed).toBe(item.declaredBytes);
  }
}
function harness(options: ConstructorParameters<typeof VndbTablesStore>[1] = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'vndb-tables-'));
  const path = resolve(directory, 'stage.sqlite');
  const evidence = sqliteEvidence();
  let db: Database;
  let store: VndbTablesStore;
  const open = () => {
    db = new Database(path);
    evidence.attach(db);
    store = new VndbTablesStore(db, { childRowsPerVn: 8, ...options });
  };
  open();
  return {
    get db() {
      return db;
    },
    get store() {
      return store;
    },
    async stage(run: string, entries = fixture()) {
      store.begin(source, run);
      await store.stage(source, run, stream(entries));
    },
    async measure<T>(operation: () => T | Promise<T>) {
      evidence.start();
      try {
        const value = await operation();
        return { value, cost: evidence.finish() };
      } catch (error) {
        evidence.cancel();
        throw error;
      }
    },
    reopen() {
      db.close();
      open();
    },
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('real COPY tables materialize a bounded grouped VN after all headers validate', async () => {
  const h = harness();
  let release!: () => void;
  let pending: Promise<void> | undefined;
  try {
    h.store.begin(source, 'reverse');
    expect(() => h.store.page(source, 'reverse', { after: null, limit: 1 })).toThrow();
    let arrived!: () => void;
    const waiting = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    pending = h.store.stage(
      source,
      'reverse',
      (async function* () {
        yield* stream(fixture().reverse());
        arrived();
        await gate;
      })(),
    );
    await waiting;
    expect(h.store.inspect(source, 'reverse').state).toBe('staging');
    expect(() => h.store.page(source, 'reverse', { after: null, limit: 1 })).toThrow();
    release();
    await pending;
    expect(h.store.inspect(source, 'reverse')).toMatchObject({ state: 'ready', sourceRecords: 2, stagedRows: 7 });
    const first = h.store.page(source, 'reverse', { after: null, limit: 1 });
    expect(first.next).toBe('v123');
    expect(first.records).toHaveLength(1);
    expect(first.records[0]).toEqual({
      key: 'v123',
      revision: 7,
      record: {
        vn: { id: 'v123', olang: 'en', c_votecount: 2, c_average: 700 },
        vn_titles: [
          { id: 'v123', lang: 'de', official: true, title: 'Harbor German Edition', latin: null },
          { id: 'v123', lang: 'en', official: true, title: 'Sentinel Harbor', latin: null },
        ],
        entry_meta: {
          id: 'v123',
          created: '2020-01-01',
          lastmod: '2026-10-24',
          revision: 7,
          num_edits: 6,
          num_users: 3,
        },
      },
    });
    expect(first.records[0]).not.toHaveProperty('output');
    const second = h.store.page(source, 'reverse', { after: first.next, limit: 1 });
    expect(second.next).toBeNull();
    expect(second.records[0]!.key).toBe('v124');
    expect(second.records[0]!.record.vn_titles[0]!.title).toBe('港の物語');
    h.reopen();
    expect(h.store.page(source, 'reverse', { after: null, limit: 1 })).toEqual(first);
    expect(() => h.store.begin(source, 'reverse')).toThrow();
    for (const limit of [0, 17, 1.5, NaN])
      expect(() => h.store.page(source, 'reverse', { after: null, limit })).toThrow();
    expect(() => h.store.page(source, 'reverse', { after: 'unsafe', limit: 1 })).toThrow();
  } finally {
    release?.();
    await pending?.catch(() => {});
    h.close();
  }
});

test('malformed and private archive entries never become staged source records', async () => {
  const h = harness();
  try {
    await h.stage('ready');
    const before = h.store.page(source, 'ready', { after: null, limit: 2 });
    let sequence = 0;
    const rejected = async (entries: Entry[]) => {
      const run = `bad-${++sequence}`;
      h.store.begin(source, run);
      await expect(h.store.stage(source, run, stream(entries))).rejects.toThrow();
      expect(h.store.inspect(source, run).state).toBe('failed');
      expect(() => h.store.page(source, run, { after: null, limit: 1 })).toThrow();
      h.reopen();
      expect(h.store.inspect(source, run).state).toBe('failed');
      expect(h.store.page(source, 'ready', { after: null, limit: 2 })).toEqual(before);
    };
    // Variants mirror the immutable actual-format suite, without converter/coordinator outcomes.
    for (const table of ['vn', 'vn_titles', 'entry_meta']) {
      await rejected([...fixture(), entry(`db/${table}.header`, text(`${table}.header`))]);
      await rejected([...fixture(), entry(`db/${table}`, text(table))]);
      await rejected(replace(fixture(), `db/${table}`, text(table) + text(table)));
    }
    for (const name of names) await rejected(fixture().filter((item) => item.path !== `db/${name}`));
    for (const path of ['../vn', '/db/vn', 'db/../vn', 'db/./vn', 'db//vn', 'db\\vn', 'C:\\db\\vn', 'db/vn\0'])
      await rejected([...fixture(), entry(path, 'PRIVATE_SENTINEL')]);
    for (const kind of ['symlink', 'hardlink'] as const)
      await rejected([...fixture(), { ...entry('db/vn', ''), kind, linkTarget: '../outside' }]);
    for (const bytes of [
      text('vn_titles').slice(0, -1),
      text('vn_titles') + 'v125\ten\tt\tcut\\',
      text('vn_titles').replace('\tt\t', '\tmaybe\t'),
      text('vn_titles').replace('Sentinel Harbor', '\\N'),
      'v123\ten\tt\n',
      'v123\ten\tt\tTitle\t\\N\textra\n',
      text('vn_titles').replace('Sentinel Harbor', '\\q'),
      text('vn_titles').replace('Sentinel Harbor', '\\x'),
      new Uint8Array([...encode('v123\ten\tt\t'), 0xc3, 0x28, ...encode('\t\\N\n')]),
    ])
      await rejected(replace(fixture(), 'db/vn_titles', bytes));
    for (const revision of ['7x', 'NaN', '32768', '\\N', '-1'])
      await rejected(replace(fixture(), 'db/entry_meta', text('entry_meta').replace('\t7\t', `\t${revision}\t`)));
    for (const header of [
      'id\tlang\tofficial\ttitle\tid\n',
      'id\tlang\tofficial\tfictional_title\tlatin\n',
      'DROP TABLE vn;\n',
    ])
      await rejected(replace(fixture(), 'db/vn_titles.header', header));
    for (const table of ['vn_titles', 'entry_meta']) {
      await rejected(replace(fixture(), `db/${table}`, text(table).replaceAll('v124', 'v999')));
      await rejected(
        replace(
          fixture(),
          `db/${table}`,
          text(table)
            .split('\n')
            .filter((line) => !line.startsWith('v124\t'))
            .join('\n'),
        ),
      );
    }
    await rejected(replace(fixture(), 'db/vn', text('vn').replaceAll('v123', 'r123')));
    await rejected(replace(fixture(), 'db/vn', text('vn').replace('\t700\t', '\tNaN\t')));
    for (const delta of [-1, 1]) {
      const entries = fixture();
      entries.find((item) => item.path === 'db/vn')!.declaredBytes += delta;
      await rejected(entries);
    }
    const interrupted = fixture();
    interrupted[1]!.bytes = (async function* () {
      yield encode('v123\t');
      throw new Error('PRIVATE_SENTINEL');
    })();
    await rejected(interrupted);
    let privateConsumed = 0;
    const privateEntry = entry('db/users', new Uint8Array([...encode('PRIVATE_SENTINEL'), 0xff]));
    const privateBytes = privateEntry.bytes;
    privateEntry.bytes = (async function* () {
      for await (const bytes of privateBytes) {
        privateConsumed += bytes.length;
        yield bytes;
      }
    })();
    const entries = replace(
      fixture(),
      'db/entry_meta',
      text('entry_meta') + 'r456\t2020-01-01\t2026-10-25\t23\t22\t4\n',
    );
    entries.push(
      privateEntry,
      entry('db/users.header', 'username\tPRIVATE_SENTINEL\n'),
      entry('schema.sql', 'DROP TABLE vn; -- PRIVATE_SENTINEL'),
    );
    await h.stage('private', entries.reverse());
    expect(privateConsumed).toBe(privateEntry.declaredBytes);
    expect(h.store.inspect(source, 'private')).toMatchObject({ state: 'ready', sourceRecords: 2, stagedRows: 7 });
    // Enumerating real storage is test-only and outside the indexed operation measurements.
    const tables = h.db.query("SELECT name FROM sqlite_schema WHERE type='table'").all() as { name: string }[];
    for (const { name } of tables) {
      const rows = h.db.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
      const retained = JSON.stringify(rows, (_key, value) =>
        value instanceof Uint8Array ? new TextDecoder().decode(value) : value,
      );
      for (const marker of ['PRIVATE_SENTINEL', 'UNLICENSED_DESCRIPTION_SENTINEL', 'cv123', 'db/users'])
        expect(retained).not.toContain(marker);
    }
  } finally {
    h.close();
  }
});

test('COPY decoding, reordered headers and explicit row and child caps are enforced', async () => {
  const h = harness();
  try {
    let entries = replace(fixture(), 'db/vn_titles.header', 'title\tlatin\tid\tofficial\tlang\n');
    entries = replace(
      entries,
      'db/vn_titles',
      'Harbor\\tLine\\nEnd\\rPath\\\\Port\\141\\x62港\t\\N\tv123\tt\ten\nGerman\t\\\\N\tv123\tf\tde\n港\t\tv124\tt\tja\n',
    );
    await h.stage('escapes', entries.reverse());
    const titles = h.store.page(source, 'escapes', { after: null, limit: 1 }).records[0]!.record.vn_titles;
    expect(titles.find((row) => row.lang === 'en')!.title).toBe('Harbor\tLine\nEnd\rPath\\Portab港');
    expect(titles.find((row) => row.lang === 'de')).toMatchObject({ official: false, latin: '\\N' });
    for (const [run, value] of [
      ['wide', `v123\ten\tt\t${'x'.repeat(65536)}\t\\N\n`],
      [
        'children',
        ['en', 'de', 'ja', 'fr', 'es', 'it', 'ru', 'ko', 'pl'].map((lang) => `v123\t${lang}\tt\tTitle\t\\N\n`).join(''),
      ],
    ] as const) {
      h.store.begin(source, run);
      await expect(h.store.stage(source, run, stream(replace(fixture(), 'db/vn_titles', value)))).rejects.toThrow();
      expect(h.store.inspect(source, run).state).toBe('failed');
    }
    for (const [badSource, run] of [
      ['UPPER', 'run'],
      ['x'.repeat(65), 'run'],
      [source, '../run'],
      [source, 'x'.repeat(129)],
    ])
      expect(() => h.store.begin(badSource!, run!)).toThrow();
  } finally {
    h.close();
  }
  const small = harness({ maxRows: 6 });
  try {
    small.store.begin(source, 'row-cap');
    await expect(small.store.stage(source, 'row-cap', stream(fixture()))).rejects.toThrow();
    expect(small.store.inspect(source, 'row-cap').state).toBe('failed');
  } finally {
    small.close();
  }
});

function population(size: number, children = 2) {
  const ids = ['v123', ...Array.from({ length: size }, (_, i) => `v${1000 + i}`)];
  let entries = replace(
    fixture(),
    'db/vn',
    ids.map((id) => text('vn').split('\n')[0]!.replaceAll('v123', id) + '\n').join(''),
  );
  entries = replace(
    entries,
    'db/vn_titles',
    ids
      .map((id) =>
        (id === 'v123' ? ['en', 'de', 'ja', 'fr', 'es', 'it', 'ru', 'ko'].slice(0, children) : ['en'])
          .map((lang) => `${id}\t${lang}\tt\tTitle ${id}\t\\N\n`)
          .join(''),
      )
      .join(''),
  );
  return replace(entries, 'db/entry_meta', ids.map((id) => `${id}\t2020-01-01\t2026-10-25\t7\t6\t3\n`).join(''));
}

test('grouping fixed VN uses indexed seeks at three scales', async () => {
  const h = harness();
  try {
    const pages: Sample[] = [],
      inspections: Sample[] = [],
      stages: Sample[] = [];
    let seed = 0x512;
    for (const scale of [32, 128, 512]) {
      // One deterministic population grows prior runs and the hot run in the same source/tables.
      for (let i = 0; i < scale; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        await h.stage(`history-${scale}-${seed}`, population(1));
      }
      const run = `hot-${scale}`;
      const staged = await h.measure(() => h.stage(run, population(scale)));
      stages.push({ scale, counted: countedSample([stageCheck.read(staged.cost, scale)]) });
      const measured = await h.measure(() => h.store.page(source, run, { after: null, limit: 1 }));
      expect(measured.value.records[0]!.key).toBe('v123');
      expect(measured.value.records[0]!.record.vn_titles).toHaveLength(2);
      expect(measured.cost.rows).toBeGreaterThanOrEqual(4);
      expect(measured.cost.rows).toBeLessThanOrEqual(12);
      expect(measured.cost.statements).toBeLessThanOrEqual(16);
      pages.push({ scale, counted: countedSample([fixedCheck.read(measured.cost, scale)]) });
      const inspected = await h.measure(() => h.store.inspect(source, run));
      expect(inspected.value.sourceRecords).toBe(scale + 1);
      inspections.push({ scale, counted: countedSample([fixedCheck.read(inspected.cost, scale)]) });
    }
    expect(countedViolations(fixedCheck, pages)).toEqual([]);
    expect(countedViolations(fixedCheck, inspections)).toEqual([]);
    expect(countedViolations(stageCheck, stages)).toEqual([]);
    const payloads: Sample[] = [];
    for (const children of [2, 4, 8]) {
      await h.stage(`payload-${children}`, population(32, children));
      const measured = await h.measure(() => h.store.page(source, `payload-${children}`, { after: null, limit: 1 }));
      expect(measured.value.records[0]!.record.vn_titles).toHaveLength(children);
      const scale = children * children;
      payloads.push({ scale, counted: countedSample([payloadCheck.read(measured.cost, scale)]) });
    }
    expect(countedViolations(payloadCheck, payloads)).toEqual([]);
  } finally {
    h.close();
  }
});

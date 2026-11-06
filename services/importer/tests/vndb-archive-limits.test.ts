import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import * as api from '../src/vndb-tables.ts';

const names = ['vn.header', 'vn', 'vn_titles.header', 'vn_titles', 'entry_meta.header', 'entry_meta'];
const fixtures = names.map((name) => ({
  path: `db/${name}`,
  bytes: new Uint8Array(
    readFileSync(new URL(`../../../specs/fixtures/imports/vndb-tables/db/${name}`, import.meta.url)),
  ),
}));
async function* fixture() {
  for (const item of fixtures)
    yield {
      path: item.path,
      kind: 'file' as const,
      declaredBytes: item.bytes.length,
      bytes: (async function* () {
        yield item.bytes.slice();
      })(),
    };
}

test('VNDB archive admission has finite defaults and hard byte and entry bounds', () => {
  expect(api.DEFAULT_VNDB_ARCHIVE_BYTES).toBe(16 * 1024 ** 3);
  expect(api.MAX_VNDB_ARCHIVE_BYTES).toBe(64 * 1024 ** 3);
  expect(api.DEFAULT_VNDB_ARCHIVE_ENTRIES).toBe(512);
  expect(api.MAX_VNDB_ARCHIVE_ENTRIES).toBe(2048);
  const db = new Database(':memory:');
  try {
    for (const maxArchiveBytes of [0, -1, Infinity, 1.5, 64 * 1024 ** 3 + 1])
      expect(() => new api.VndbTablesStore(db, { maxArchiveBytes })).toThrow();
    for (const maxArchiveEntries of [0, -1, Infinity, 1.5, 2049])
      expect(() => new api.VndbTablesStore(db, { maxArchiveEntries })).toThrow();
  } finally {
    db.close();
  }
});

test('all archive entries count and an excessive entry is rejected before opening its body', async () => {
  const db = new Database(':memory:');
  const store = new api.VndbTablesStore(db, { maxArchiveEntries: 2 });
  let pulls = 0;
  let bodies = 0;
  let closed = false;
  async function* entries() {
    try {
      for (let i = 0; i < 4; i++) {
        pulls++;
        yield {
          path: `ignored/${i}`,
          kind: 'file' as const,
          declaredBytes: 0,
          bytes: (async function* () {
            bodies++;
          })(),
        };
      }
    } finally {
      closed = true;
    }
  }
  try {
    store.begin('vndb', 'entries');
    await expect(store.stage('vndb', 'entries', entries())).rejects.toThrow(
      'VNDB table staging failed at phase loading',
    );
    expect(pulls).toBe(3);
    expect(bodies).toBe(2);
    expect(closed).toBe(true);
    expect(store.inspect('vndb', 'entries').state).toBe('failed');
    expect(() => store.page('vndb', 'entries', { after: null, limit: 1 })).toThrow();
  } finally {
    db.close();
  }
});

test('ignored entry bytes count toward the total before an excessive body is pulled', async () => {
  const db = new Database(':memory:');
  const store = new api.VndbTablesStore(db, { maxArchiveBytes: 4 });
  let pulls = 0;
  let bodies = 0;
  async function* entries() {
    for (const size of [3, 2, 1]) {
      pulls++;
      yield {
        path: `ignored/${pulls}`,
        kind: 'file' as const,
        declaredBytes: size,
        bytes: (async function* () {
          bodies++;
          yield new Uint8Array(size);
        })(),
      };
    }
  }
  try {
    store.begin('vndb', 'bytes');
    await expect(store.stage('vndb', 'bytes', entries())).rejects.toThrow(
      'VNDB table staging failed at phase loading',
    );
    expect(pulls).toBe(2);
    expect(bodies).toBe(1);
    expect(store.inspect('vndb', 'bytes').state).toBe('failed');
  } finally {
    db.close();
  }
});

test('native table archives remain valid at the exact configured admission limits', async () => {
  const db = new Database(':memory:');
  const bytes = fixtures.reduce((sum, entry) => sum + entry.bytes.length, 0);
  const store = new api.VndbTablesStore(db, { maxArchiveBytes: bytes, maxArchiveEntries: fixtures.length });
  try {
    store.begin('vndb', 'exact');
    await store.stage('vndb', 'exact', fixture());
    expect(store.inspect('vndb', 'exact').state).toBe('ready');
    expect(store.page('vndb', 'exact', { after: null, limit: 16 }).records).toHaveLength(2);
  } finally {
    db.close();
  }
});

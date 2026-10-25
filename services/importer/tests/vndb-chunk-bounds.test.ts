import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { VndbTablesStore } from '../src/vndb-tables.ts';
import { MAX_DUMP_CHUNK_BYTES } from '../src/dumps-bytes.ts';

const names = ['vn.header', 'vn', 'vn_titles.header', 'vn_titles', 'entry_meta.header', 'entry_meta'];
async function* fixture() {
  for (const name of names) {
    const bytes = readFileSync(new URL(`../../../specs/fixtures/imports/vndb-tables/db/${name}`, import.meta.url));
    yield {
      path: `db/${name}`,
      kind: 'file' as const,
      declaredBytes: bytes.length,
      bytes: (async function* () {
        for (let offset = 0; offset < bytes.length; offset += 128)
          yield Uint8Array.from(bytes.subarray(offset, offset + 128));
      })(),
    };
  }
}

test('raw VNDB entry boundary rejects oversized backing even for discarded user data', async () => {
  const db = new Database(':memory:');
  const store = new VndbTablesStore(db, { childRowsPerVn: 8, pageSize: 16 });
  try {
    store.begin('vndb', 'chunk-test');
    const entries = (async function* () {
      yield* fixture();
      yield {
        path: 'db/user_posts',
        kind: 'file' as const,
        declaredBytes: 1,
        bytes: (async function* () {
          yield new Uint8Array(new ArrayBuffer(MAX_DUMP_CHUNK_BYTES + 1), 0, 1);
        })(),
      };
    })();
    await expect(store.stage('vndb', 'chunk-test', entries)).rejects.toThrow();
    expect(store.inspect('vndb', 'chunk-test').state).toBe('failed');
    expect(() => store.page('vndb', 'chunk-test', { after: null, limit: 1 })).toThrow();
  } finally {
    db.close();
  }
});

test('native table bytes larger than a chunk remain valid through bounded owned chunks', async () => {
  const db = new Database(':memory:');
  const store = new VndbTablesStore(db, { childRowsPerVn: 8, pageSize: 16 });
  try {
    store.begin('vndb', 'valid-chunks');
    await store.stage('vndb', 'valid-chunks', fixture());
    expect(store.inspect('vndb', 'valid-chunks').state).toBe('ready');
    expect(store.page('vndb', 'valid-chunks', { after: null, limit: 16 }).records).toHaveLength(2);
  } finally {
    db.close();
  }
});

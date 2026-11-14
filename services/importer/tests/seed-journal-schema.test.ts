import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CrossMediaGraph } from '../src/cross-media-bindings.ts';
import { ShowcaseJournal } from '../src/showcase-journal.ts';

test('an old graph schema is refused without changing its retained proposal', () => {
  const database = new Database(':memory:');
  try {
    database.exec(`CREATE TABLE cross_media_graph (
      edge_key TEXT PRIMARY KEY, alias TEXT, table_name TEXT, holder TEXT, target TEXT,
      property TEXT, payload TEXT, status TEXT, command_key TEXT
    )`);
    database
      .query('INSERT INTO cross_media_graph VALUES(?,?,?,?,?,?,?,?,?)')
      .run('edge', 'source', 'relations', 'holder', 'target', 'property', '{"original":true}', 'proposed', 'sealed-key');
    const before = database.query('SELECT * FROM cross_media_graph').all();
    expect(() => new CrossMediaGraph(database)).toThrow('explicit state maintenance');
    expect(database.query('SELECT * FROM cross_media_graph').all()).toEqual(before);
    expect(database.query('PRAGMA table_info(cross_media_graph)').all()).toHaveLength(9);
  } finally {
    database.close();
  }
});

test('an old cover journal retains exact source evidence when canonical open is refused', () => {
  const temporary = join(import.meta.dir, '../../../.temp');
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(join(temporary, 'seed-journal-schema-'));
  const path = join(directory, 'journal.sqlite');
  const database = new Database(path);
  try {
    database.exec(`CREATE TABLE showcase_cover_source (
      source_alias TEXT, external_id TEXT, archive_digest TEXT, source_json TEXT,
      PRIMARY KEY(source_alias,external_id,archive_digest)
    )`);
    const source = '{"responseDigest":"original-response","source":"exact bytes"}';
    database.query('INSERT INTO showcase_cover_source VALUES(?,?,?,?)').run('source', 'record', 'archive', source);
    expect(() => new ShowcaseJournal(path)).toThrow('explicit state maintenance');
    expect(database.query('SELECT source_json FROM showcase_cover_source').get()).toEqual({ source_json: source });
    expect(database.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual([
      { name: 'showcase_cover_source' },
    ]);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

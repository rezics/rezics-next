import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RecordStore, RECORD_LOOKUP_SQL, type RecordRow } from '../src/record-store.ts';

const row = (source: string, key: string, state: 'present' | 'vanished' = 'present'): RecordRow => ({
  source,
  recordKey: key,
  recordRevision: 'unversioned',
  digest: 'a'.repeat(64),
  converter_revision: 'source@1',
  state,
});
function fixture(run: (path: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'record-store-'));
  try {
    run(join(directory, 'imports.sqlite'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('acknowledged records survive reopening without crossing source keys', () =>
  fixture((path) => {
    let db = new RecordStore(path);
    db.put(row('bangumi', '12'));
    db.put({ ...row('vndb', '12'), recordRevision: '7', converter_revision: 'vndb@2' });
    db.close();
    db = new RecordStore(path);
    try {
      expect(db.get('bangumi', '12')).toEqual(row('bangumi', '12'));
      expect(db.get('vndb', '12')).toEqual({ ...row('vndb', '12'), recordRevision: '7', converter_revision: 'vndb@2' });
      expect(db.get('wikidata', '12')).toBeNull();
      expect(db.count('bangumi')).toBe(1);
      expect(db.count('vndb')).toBe(1);
      const before = db.get('bangumi', '12');
      expect(() => db.put({ ...row('bangumi', '12'), digest: 'bad' })).toThrow();
      expect(db.get('bangumi', '12')).toEqual(before);
    } finally {
      db.close();
    }
  }));

test('vanished state changes maintained counters idempotently', () =>
  fixture((path) => {
    const db = new RecordStore(path);
    try {
      db.put(row('wikidata', 'Q1'));
      db.put(row('wikidata', 'Q1'));
      expect(db.count('wikidata')).toBe(1);
      db.put(row('wikidata', 'Q1', 'vanished'));
      db.put(row('wikidata', 'Q1', 'vanished'));
      expect(db.count('wikidata')).toBe(0);
      expect(db.get('wikidata', 'Q1')?.state).toBe('vanished');
      db.put({ ...row('wikidata', 'Q1'), recordRevision: '9', digest: 'b'.repeat(64) });
      expect(db.count('wikidata')).toBe(1);
      expect(db.get('wikidata', 'Q1')?.recordRevision).toBe('9');
    } finally {
      db.close();
    }
  }));

test('reads and bounded pages use indexed keys at three scales', () =>
  fixture((path) => {
    const statements: string[] = [];
    const db = new RecordStore(path, { onStatement: (sql) => statements.push(sql) });
    let seeded = 0;
    function seed(scale: number) {
      for (; seeded < scale; seeded++) {
        db.put(row('wikidata', `Q${String(seeded).padStart(6, '0')}`));
        db.put(row('bangumi', String(seeded)));
      }
    }
    const samples: number[] = [];
    try {
      for (const scale of [32, 128, 512]) {
        seed(scale);
        statements.length = 0;
        expect(db.get('wikidata', 'Q000001')).toEqual(row('wikidata', 'Q000001'));
        expect(db.count('wikidata')).toBe(scale);
        const page = db.page('wikidata', { after: 'Q000001', limit: 3 });
        expect(page.map((r) => r.recordKey)).toEqual(['Q000002', 'Q000003', 'Q000004']);
        samples.push(statements.length);
        expect(statements.length).toBeGreaterThan(0);
        expect(statements.length).toBeLessThanOrEqual(4);
        expect(statements.some((sql) => /\bOFFSET\b|\bCOUNT\s*\(/i.test(sql))).toBe(false);
        const plan = db.database.query(`EXPLAIN QUERY PLAN ${RECORD_LOOKUP_SQL}`).all('wikidata', 'Q000001') as {
          detail: string;
        }[];
        const text = plan.map((p) => p.detail).join(' ');
        expect(text).toMatch(/SEARCH/i);
        expect(text).toMatch(/source\s*=\s*\?.*record_key\s*=\s*\?/i);
        expect(text).not.toMatch(/\bSCAN\b/i);
      }
      expect(new Set(samples).size).toBe(1);
      expect(() => db.page('wikidata', { after: '', limit: 101 })).toThrow();
      expect(() => db.page('wikidata', { after: '', limit: 0 })).toThrow();
    } finally {
      db.close();
    }
  }));

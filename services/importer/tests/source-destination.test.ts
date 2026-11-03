import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ImportSession } from '../src/import-session.ts';
import {
  evaluateAdmission,
  insertSourceDestination,
  normalizeApiOrigin,
  preflightSourceDestination,
  readSourceDestination,
  reviewSourceDestination,
  sourceHasHistory,
} from '../src/source-destination.ts';
import type { SourceProjection } from '../src/run-store.ts';

const temporaryRoot = resolve(import.meta.dir, '../../../.temp');
const originA = 'https://api.a.example';
const originB = 'https://api.b.example';

function directory() {
  mkdirSync(temporaryRoot, { recursive: true });
  const path = mkdtempSync(join(temporaryRoot, 'source-destination-'));
  return {
    path,
    state: join(path, 'state.sqlite'),
    close() {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

function staged(source: string, key: string) {
  return {
    row: {
      source,
      recordKey: key,
      recordRevision: 'revision-1',
      digest: 'a'.repeat(64),
      converter_revision: 'test@1',
      state: 'present' as const,
    },
    projection: {
      sourceKind: 'wikidata' as const,
      normalizedRecord: { id: key, type: 'item', labels: {}, descriptions: {}, aliases: {}, claims: {} },
    } satisfies SourceProjection,
  };
}

function history(path: string, source = 'wikidata') {
  const session = new ImportSession(path);
  const run = session.store.begin(source);
  if (run === 'busy') throw new Error('busy');
  session.store.stage(run, staged(source, 'Q1'));
  expect(session.store.seal(run, { complete: true }).status).toBe('ready');
  session.store.classify(run, 'Q1', { commands: [] });
  session.store.acknowledgeNoEffects(run, 'Q1', { reason: 'no-owned-candidates' });
  expect(session.store.finalize(run, 100)).toBe('complete');
  const pending = session.store.database.query('SELECT bytes FROM run_envelopes').all();
  const acknowledged = session.store.database.query('SELECT record_key FROM run_acknowledged').all();
  session.close();
  return { pending, acknowledged };
}

function dropDestination(path: string) {
  const database = new Database(path);
  database.exec('DROP TABLE IF EXISTS source_destinations');
  database.close();
}

test('origin parser normalizes equivalent HTTPS origins and rejects credentials, path and http', () => {
  expect(normalizeApiOrigin('https://API.Example.com:443')).toBe('https://api.example.com');
  expect(normalizeApiOrigin('https://api.example.com')).toBe('https://api.example.com');
  expect(() => normalizeApiOrigin('https://user:pass@api.example.com')).toThrow(
    'no path, query, fragment or credentials',
  );
  expect(() => normalizeApiOrigin('https://api.example.com/v1')).toThrow('no path, query, fragment or credentials');
  expect(() => normalizeApiOrigin('https://api.example.com/?x=1')).toThrow('no path, query, fragment or credentials');
  expect(() => normalizeApiOrigin('http://api.example.com')).toThrow('HTTPS origin');
  expect(normalizeApiOrigin('http://127.0.0.1:43179', 'http://127.0.0.1:43179')).toBe('http://127.0.0.1:43179');
});

test('first-use admit records origin; a later different origin is refused without rotating ownership', () => {
  const dir = directory();
  try {
    const session = new ImportSession(dir.state);
    const first = session.admit('wikidata', originA);
    expect(first).not.toBe('busy');
    expect('kind' in (first as object)).toBe(false);
    expect(readSourceDestination(session.store.database, 'wikidata')).toEqual({
      origin: originA,
      provenance: 'first-use',
      schemaVersion: 1,
    });
    expect(session.readOwner('wikidata')).not.toBeNull();
    session.release(first as { source: string; capability: string });
    session.close();

    const other = new ImportSession(dir.state);
    const refused = other.admit('wikidata', originB);
    expect(refused).toMatchObject({ kind: 'mismatch', binding: { origin: originA, provenance: 'first-use' } });
    expect(other.readOwner('wikidata')).toBeNull();
    expect(readSourceDestination(other.store.database, 'wikidata')).toEqual({
      origin: originA,
      provenance: 'first-use',
      schemaVersion: 1,
    });
    expect(readSourceDestination(other.store.database, 'openlibrary')).toBeNull();
    other.close();
  } finally {
    dir.close();
  }
});

test('unrelated sources in one database are admitted independently', () => {
  const dir = directory();
  try {
    const session = new ImportSession(dir.state);
    expect(session.admit('wikidata', originA)).not.toBe('busy');
    expect(session.admit('openlibrary', originB)).not.toBe('busy');
    expect(readSourceDestination(session.store.database, 'wikidata')).toMatchObject({ origin: originA });
    expect(readSourceDestination(session.store.database, 'openlibrary')).toMatchObject({ origin: originB });
    session.close();
  } finally {
    dir.close();
  }
});

test('legacy history without a destination row is unbound until explicit insert', () => {
  const dir = directory();
  try {
    const before = history(dir.state);
    dropDestination(dir.state);
    const database = new Database(dir.state, { readonly: true, create: false });
    expect(sourceHasHistory(database, 'wikidata')).toBe(true);
    expect(readSourceDestination(database, 'wikidata')).toBeNull();
    expect(evaluateAdmission(database, 'wikidata', originA)).toEqual({ kind: 'unbound' });
    const review = reviewSourceDestination(database, 'wikidata', originA);
    expect(review.status).toBe('unbound');
    expect(review.recorded).toBeNull();
    expect(review.pendingWork.envelopes).toBe(0);
    database.close();

    const session = new ImportSession(dir.state);
    expect(session.admit('wikidata', originA)).toMatchObject({ kind: 'unbound' });
    expect(session.readOwner('wikidata')).toBeNull();
    insertSourceDestination(session.store.database, 'wikidata', originA, 'operator-declared');
    expect(readSourceDestination(session.store.database, 'wikidata')).toMatchObject({
      origin: originA,
      provenance: 'operator-declared',
    });
    expect(session.store.database.query('SELECT bytes FROM run_envelopes').all()).toEqual(before.pending);
    expect(session.store.database.query('SELECT record_key FROM run_acknowledged').all()).toEqual(before.acknowledged);
    session.close();
  } finally {
    dir.close();
  }
});

test('first-use races to different origins leave one winner and an unchanged loser', () => {
  const dir = directory();
  try {
    const winner = new ImportSession(dir.state);
    const loser = new ImportSession(dir.state);
    const accepted = winner.admit('wikidata', originA);
    expect(accepted).not.toBe('busy');
    expect('kind' in (accepted as object)).toBe(false);
    const refused = loser.admit('wikidata', originB);
    expect(refused).toMatchObject({ kind: 'mismatch', binding: { origin: originA } });
    expect(loser.readOwner('wikidata')).toEqual(winner.readOwner('wikidata'));
    expect(readSourceDestination(loser.store.database, 'wikidata')).toMatchObject({
      origin: originA,
      provenance: 'first-use',
    });
    winner.close();
    loser.close();
  } finally {
    dir.close();
  }
});

test('missing and corrupt databases are distinct from unbound history', async () => {
  const dir = directory();
  try {
    const empty = new Database(':memory:');
    expect(sourceHasHistory(empty, 'wikidata')).toBe(false);
    expect(evaluateAdmission(empty, 'wikidata', originA)).toBe('first-use');
    empty.close();

    const missing = await preflightSourceDestination({
      statePath: join(dir.path, 'missing.sqlite'),
      source: 'wikidata',
      origin: originA,
      missingState: 'error',
    });
    expect(missing).toMatchObject({ status: 'unavailable' });

    writeFileSync(dir.state, 'not-sqlite');
    const corrupt = await preflightSourceDestination({
      statePath: dir.state,
      source: 'wikidata',
      origin: originA,
      missingState: 'error',
    });
    expect(corrupt.status).toBe('unavailable');
  } finally {
    dir.close();
  }
});

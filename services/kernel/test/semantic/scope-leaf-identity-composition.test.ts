import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mergeSubjects } from '../../src/semantic/merges.ts';
import { moveMergePage } from '../../src/semantic/merge-moves.ts';
import { decodeListCursor, encodeListCursor } from '../../src/tokens/list-cursor.ts';
import { capture, costOf, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import {
  current,
  deadline,
  languageLeaf,
  leafFixture,
  leafReader,
  nativeRelease,
  requiredExport,
  type AliasReader,
  type BasisReader,
  type LeafFixture,
  type TerminalReader,
} from './scope-leaf-evidence-fixture.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
let db: GrowthDatabase;
let f: LeafFixture;
beforeAll(async () => {
  db = await openGrowthDatabase(url);
  f = await leafFixture(db.pool, db.admin);
});
afterAll(async () => {
  if (db) await db.close();
});

test('native identity ports and one-owner raw progress preserve independent alias continuation in eight encrypted keys', async () => {
  const book = await f.baseline();
  const read = await leafReader();
  const basisReader = await requiredExport<BasisReader>('semantic/identity-basis', 'readIdentityBasis');
  const terminalReader = await requiredExport<TerminalReader>(
    'semantic/terminal-identity',
    'readTerminalSubjectIdentity',
  );
  const aliases = await requiredExport<AliasReader>('semantic/alias-group', 'readSubjectAliasGroup');
  const pool = db.openPool({ max: 1 });
  try {
    const terminal = await terminalReader(pool, book, f.options());
    expect(terminal?.state).toBe('ready');
    // Actual metadata work is separately measured, not hidden in each candidate leaf's receipt.
    const sweep = await capture(db, () => basisReader(pool, { deadline: deadline() }));
    expect(sweep.value.state).toBe('ready');
    expect(costOf(sweep.capture).rows).toBeGreaterThanOrEqual(8192);
    if (sweep.value.state !== 'ready') throw new Error('Expected ready structural basis');
    const window = await aliases(pool, {
      terminal: book,
      basis: sweep.value.basis,
      after: null,
      limit: 16,
      deadline: deadline(),
    });
    expect(window.state).toBe('ready');
    if (window.state !== 'ready') throw new Error('Expected real alias window');
    expect(window.originals).toContain(book);
    const evidence = current(await read(pool, f.request(book, languageLeaf), f.options()));
    expect(pool.waitingCount).toBe(0);
    expect(pool.idleCount).toBe(pool.totalCount);
    // The fixed raw wire has no leaf truth, nested tokens, or variable JSON payload.
    const record = Buffer.alloc(18);
    record[0] = (1 << 5) | 0; // version1, deterministic leaf0
    record[1] = (1 << 6) | 0; // selection phase, value0
    record.writeBigUInt64BE(16n, 2);
    const sourceAfter = record.toString('base64url');
    expect(sourceAfter.length).toBe(24);
    const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(83)]]) };
    const binding = {
      route: 'GET /v1/zones/{id}/subjects',
      viewer: null,
      query: { zone: book, query: 'current-evidence', limit: 100 },
    };
    const position = [sweep.value.basis.digest, '', book, 0, book, sourceAfter, evidence.basis, 1];
    const token = await encodeListCursor(ring, binding, { epoch: 1, after: position }, new Date());
    const decoded = await decodeListCursor(ring, binding, token, new Date());
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.after).toEqual(position);
    expect(
      await decodeListCursor(ring, { ...binding, query: { ...binding.query, limit: 99 } }, token, new Date()),
    ).toEqual({ ok: false, reason: 'invalid' });
    expect((await decodeListCursor(ring, { ...binding, viewer: newIdForBinding }, token, new Date())).ok).toBe(false);
  } finally {
    await pool.end();
  }
}, 120_000);
const newIdForBinding = '019a1b2c-3d4e-7f00-8a00-ed170e000083';

test('last native alias remains discoverable through actual bounded group maintenance', async () => {
  const root = await f.baseline();
  await leafReader();
  const basisReader = await requiredExport<BasisReader>('semantic/identity-basis', 'readIdentityBasis');
  const terminalReader = await requiredExport<TerminalReader>(
    'semantic/terminal-identity',
    'readTerminalSubjectIdentity',
  );
  const aliases = await requiredExport<AliasReader>('semantic/alias-group', 'readSubjectAliasGroup');
  for (const count of [257, 4096]) {
    const terminal = count === 257 ? root : await f.baseline();
    const originals: string[] = [];
    for (let index = 0; index < count; index++) originals.push(await f.create('schema:Book'));
    originals.sort();
    for (const original of originals) {
      await mergeSubjects(db.pool, {
        ...(await f.command('subject:merge')),
        subjects: [original, terminal],
        survivor: terminal,
        release: nativeRelease,
      });
      for (let page = 0; ; page++) {
        expect(page).toBeLessThan(1000);
        if (!(await moveMergePage(db.pool, original, terminal))) break;
      }
    }
    for (const original of originals.slice(0, -1)) await f.hideSubject(original);
    const basis = await basisReader(db.pool, { deadline: deadline() });
    expect(basis.state).toBe('ready');
    if (basis.state !== 'ready') throw new Error('Expected finite native identity maintenance');
    let after: string | null = null;
    let found = false;
    for (let step = 0; step < count; step++) {
      const window = await aliases(db.pool, { terminal, basis: basis.basis, after, limit: 16, deadline: deadline() });
      expect(window.state).toBe('ready');
      if (window.state !== 'ready') throw new Error('Expected advancing native aliases');
      expect(window.examined).toBeLessThanOrEqual(17);
      for (const original of window.originals) {
        const result = await terminalReader(db.pool, original, f.options());
        if (original === originals.at(-1)) {
          expect(result?.state).toBe('ready');
          found = true;
        }
      }
      if (found || window.exhausted) break;
      expect(window.after! > (after ?? '')).toBe(true);
      after = window.after;
    }
    expect(found).toBe(true);
  }
}, 1_800_000);

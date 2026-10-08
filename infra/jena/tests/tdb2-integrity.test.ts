import { afterAll, expect, test } from 'bun:test';
import { closeSync, openSync, readdirSync, rmSync, ftruncateSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { freshDirectory, lastJsonLine, runJava } from './tdb2-integrity/support.ts';

const directories: string[] = [];
const fresh = (label: string) => {
  const directory = freshDirectory(label);
  directories.push(directory);
  return directory;
};
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

type Scan = {
  damage: number;
  samples: string[];
  nodeFileLength: number;
  journalBytesBeforeOpen: number;
  quads: Record<string, { tuples: number; absentFromPrimary?: number }>;
  pointers: { distinctPointers: number; beyondNodeFile: number; undecodable: number; decodeToAnotherId: number };
  nodeTable: { entries: number; nodeToIdMismatch: number };
};
const scan = (database: string) => {
  const result = runJava('ScanTdb2', ['/database'], database, '2g');
  return { status: result.status, report: lastJsonLine<Scan>(result.stdout) };
};
const populated = () => {
  const database = fresh('populated');
  const result = runJava('Tdb2Fixture', ['populate', '/database'], database, '1g');
  expect(result.status).toBe(0);
  return database;
};

test('a store with committed and aborted writes scans clean and every index holds the same quads', () => {
  const { status, report } = scan(populated());
  expect(report.samples).toEqual([]);
  expect(status).toBe(0);
  expect(report.damage).toBe(0);
  const counts = Object.values(report.quads).map((index) => index.tuples);
  expect(counts).toHaveLength(6);
  expect(new Set(counts)).toEqual(new Set([2000]));
  expect(report.pointers).toMatchObject({ beyondNodeFile: 0, undecodable: 0, decodeToAnotherId: 0 });
  expect(report.journalBytesBeforeOpen).toBe(0);
}, 300_000);

test('a node file shorter than its indexes is damage, reported as pointers beyond the file', () => {
  const database = populated();
  const data = join(database, readdirSync(database).find((name) => /^Data-\d+$/.test(name))!);
  const nodes = join(data, 'nodes-data.obj');
  const full = statSync(nodes).size;
  const descriptor = openSync(nodes, 'r+');
  ftruncateSync(descriptor, full - 4096);
  closeSync(descriptor);
  const { status, report } = scan(database);
  expect(status).toBe(1);
  expect(report.damage).toBeGreaterThan(0);
  expect(report.pointers.beyondNodeFile + report.pointers.undecodable).toBeGreaterThan(0);
}, 300_000);

// Jena 6.2.0 releases the node file's committed length (and the writer lock) only when every
// component finishes its commit. A component that fails after the journal's commit point leaves
// quad indexes that name nodes beyond what readers may read. These facts pin that behaviour: when
// a Jena release changes them, the fail-stop rule in docs/operations/tdb2-integrity.md can change.
test('a commit that fails past its commit point leaves readers out of bounds until the next open replays the journal', () => {
  const outcomes: Array<{
    commitThrew: string;
    journalBytes: number;
    nextWriterBlocked: boolean;
    found: number;
    readError: string;
    after: { journalBytesBeforeOpen: number; found: number; readError: string };
    damage: number;
  }> = [];
  // Components commit in a hash order that changes per JVM; the node file is read-visible only when
  // some quad index committed before it, so try fresh stores until that order shows.
  for (let attempt = 0; attempt < 12 && !outcomes.some((o) => o.readError.startsWith('RuntimeIOException: Out of bounds')); attempt++) {
    const database = fresh('commit-failure');
    const failed = lastJsonLine<(typeof outcomes)[number]>(
      runJava('Tdb2Fixture', ['commit-failure', '/database', 'nodes-data'], database, '1g').stdout,
    );
    const reopened = lastJsonLine<(typeof outcomes)[number]['after']>(
      runJava('Tdb2Fixture', ['reopen', '/database'], database, '1g').stdout,
    );
    const { report } = scan(database);
    outcomes.push({ ...failed, after: reopened, damage: report.damage });
  }
  for (const outcome of outcomes) {
    expect(outcome.commitThrew).not.toBe('');
    expect(outcome.journalBytes).toBeGreaterThan(0);
    expect(outcome.nextWriterBlocked).toBe(true);
    expect(outcome.after.journalBytesBeforeOpen).toBeGreaterThan(0);
    expect(outcome.after).toMatchObject({ found: 200, readError: '' });
    expect(outcome.damage).toBe(0);
  }
  const outOfBounds = outcomes.find((o) => o.readError.startsWith('RuntimeIOException: Out of bounds'));
  expect(outOfBounds).toBeDefined();
  expect(outOfBounds!.readError).toMatch(/^RuntimeIOException: Out of bounds: \(limit \d+\) \d+$/);
}, 300_000);

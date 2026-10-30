import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { runVndbMaterializationPublication } from './vndb-materialization-native-fixture.ts';

test('all fourteen current statistic-bearing VNDB table materialization outcomes run through the real producer', async () => {
  const suite = resolve(import.meta.dir, '../../../../specs/imports-vndb-tables.test.ts');
  const driver = resolve(import.meta.dir, 'vndb-materialization-native-fixture.ts');
  const child = Bun.spawn([process.execPath, 'test', '--timeout', '300000', suite], {
    env: { ...process.env, IMPORT_VNDB_TABLES_DRIVER: driver },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const output = stdout + stderr;
  if (code !== 0) console.error(output);
  expect(code).toBe(0);
  expect(output).toMatch(/^\s*14 pass$/m);
  expect(output).toMatch(/^\s*0 fail$/m);
  expect(output).not.toMatch(/^\s*[1-9]\d* (skip|todo)$/m);
}, 1_800_000);

test('ordinary VNDB CLI publishes the same durable grouped revision and licensed statistic then safely reopens', async () => {
  const r = await runVndbMaterializationPublication();
  try {
    expect(r.cli.code).toBe(0);
    expect(r.grouped.record.vn.c_votecount).toBe(2);
    expect(r.grouped.record.vn.c_average).toBe(700);
    expect(r.grouped.revision).toBe(7);
    expect(r.publicStatistic.mean).toBe(7);
    expect(r.publicStatistic.count).toBe(2);
    expect(r.publicStatistic.licence).toBe('ODbL-1.0');
    expect(r.nativeVoteRows).toBe(0);
    expect(r.unchanged.code).toBe(0);
    expect(r.unchangedWrites).toEqual([]);
    expect(r.unsafe.code).toBe(2);
    expect(r.unsafeWrites).toEqual([]);
    expect(r.baselineAfterUnsafe).toEqual(r.baselineBeforeUnsafe);
    expect(r.originalReceiptsAfter).toEqual(r.originalReceiptsBefore);
    expect(r.unlicensedMarkers).toEqual([]);
  } finally {
    await r.close();
  }
}, 1_800_000);

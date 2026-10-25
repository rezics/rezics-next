#!/usr/bin/env bun
/** Test support only. A green missing-driver check is never product acceptance. */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { GrowingRelation, SqliteStatement } from '../imports-growth-driver';

/** Check EVERY execution, including SELECT/UPDATE/DELETE and self-join aliases. */
export function assertIndexedSqlite(
  statement: SqliteStatement,
  metadata: { analyzed: boolean; growingRelations: readonly GrowingRelation[] },
): void {
  assert(metadata.analyzed, 'ANALYZE must run outside measurement at every scale');
  assert(metadata.growingRelations.length > 0);
  assert(statement.parameters);
  assert(!/\bCOUNT\s*\(/i.test(statement.sql), 'Read maintained counters, never history COUNT');
  for (const value of Object.values(statement.parameters))
    assert(value === null || ['string', 'number', 'bigint'].includes(typeof value) || value instanceof Uint8Array);
  assert(Number.isSafeInteger(statement.rowsReturned) && statement.rowsReturned >= 0);
  const plan = JSON.parse(statement.explain) as { detail: string }[];
  assert(Array.isArray(plan));
  for (const row of plan) {
    assert.equal(typeof row.detail, 'string');
    assert(!/\bSCAN\b|USE TEMP B-TREE|AUTOMATIC/i.test(row.detail), row.detail);
  }
  if (statement.classification === 'transaction-control') {
    assert(
      /^\s*(?:BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\s+TRANSACTION)?|COMMIT|END|ROLLBACK(?:\s+TO(?:\s+SAVEPOINT)?\s+\w+)?|SAVEPOINT\s+\w+|RELEASE(?:\s+SAVEPOINT)?\s+\w+)\s*;?\s*$/i.test(
        statement.sql,
      ),
    );
    assert.deepEqual(plan, []);
    assert.deepEqual(statement.reads, []);
    assert.equal(statement.rowsReturned, 0);
    return;
  }
  if (statement.classification === 'keyed-insert') {
    // Only one bound VALUES tuple on an actual declared unique key. No SELECT,
    // UPSERT subquery, UPDATE or DELETE can acquire this exemption by spelling.
    const insert =
      /^\s*INSERT(?:\s+OR\s+(?:IGNORE|ABORT|FAIL|ROLLBACK))?\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)\s*;?\s*$/i.exec(
        statement.sql,
      );
    assert(insert);
    const table = metadata.growingRelations.find((r) => r.table === insert[1]);
    assert(table);
    const columns = insert[2]!.split(',').map((v) => v.trim());
    const values = insert[3]!.split(',').map((v) => v.trim());
    assert.equal(columns.length, values.length);
    for (const value of values) assert(/^(?:\?\d*|[:@$]\w+)$/.test(value));
    const keys = table.indexes.filter((i) => i.unique).map((i) => i.columns);
    if (table.integerPrimaryKey) keys.push([table.integerPrimaryKey]);
    assert(keys.some((key) => key.length > 0 && key.every((column) => columns.includes(column))));
    assert.deepEqual(plan, []);
    assert.deepEqual(statement.reads, []);
    return;
  }
  assert.equal(statement.classification, 'readable');
  assert(plan.length > 0);
  const searches = plan.filter((row) => /^SEARCH /i.test(row.detail));
  for (const read of statement.reads) {
    const table = metadata.growingRelations.find((r) => r.table === read.table);
    assert(table);
    const nodes = searches.filter((row) => row.detail.split(/\s+/)[1] === read.alias);
    assert(nodes.length > 0, `Missing indexed search for ${read.alias}`);
    for (const node of nodes) {
      const access = / USING (?:COVERING )?(?:INDEX (\S+)|INTEGER PRIMARY KEY) \((.+)\)$/i.exec(node.detail);
      assert(access, node.detail);
      const index: GrowingRelation['indexes'][number] | undefined = table.indexes.find((i) => i.name === access[1]);
      if (access[1]) assert(index);
      else assert(table.integerPrimaryKey);
      const first: string = access[2]!.split(/ AND /i)[0]!;
      assert(/^[\w]+\s*(?:=|>|<|>=|<=)\s*\?$/.test(first));
      assert.equal(first.split(/\s*[=<>]/)[0], index?.columns[0] ?? 'rowid');
    }
  }
  for (const node of searches)
    assert(
      statement.reads.some((read) => read.alias === node.detail.split(/\s+/)[1]),
      'Unaccounted relation read',
    );
}

if (import.meta.main) {
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL('./verify-outcome-suite.ts', import.meta.url)),
      fileURLToPath(new URL('../imports-api.test.ts', import.meta.url)),
      'IMPORT_API_DRIVER',
      'IMPORT_API_DRIVER is required: bind the real importer and public API',
    ],
    { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
  );
  process.exitCode = await child.exited;
}

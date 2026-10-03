import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { migrationRecords } from '../../../scripts/ops/migrate.ts';
import { uuidToSid } from '@rezics/model/address/sid';

const registryTables = [
  'name_reserved_word',
  'name_registry',
  'name_history',
  'name_receipt',
  'name_graph_import',
  'name_graph_import_report',
] as const;

test('G1023: 1029 upgrades a restored alias inventory twice without changing holders, history or guards', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through isolated integration QA');
  const client = new Client({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  await client.connect();
  const holder = `https://rezics.com/id/${randomUUID()}`;
  const other = `https://rezics.com/id/${randomUUID()}`;
  const revision = randomUUID(),
    previous = randomUUID(),
    principal = randomUUID();
  const oldMigrations = migrationRecords(process.cwd(), 'access')
    .filter((file) => file.version < 1029)
    .map((file) => readFileSync(file.name, 'utf8'));
  const migration = readFileSync(
    'services/main/migrations/access/1029_alias_vocabulary.sql',
    'utf8',
  );
  // Reconstruct only this disposable QA project's owners, as G991 does.
  // Each migration commits separately so schema rebuilding does not hold locks
  // for two complete owner inventories in one transaction. Restore the same
  // consistent logical backup; never mutate the shared backend or fixture.
  const recreate = async () => {
    // Migration 875's normalization helper is session-local, rather than part
    // of the owner schema; release it before reconstructing that cut again.
    await client.query('DROP FUNCTION IF EXISTS pg_temp.reading_language(text)');
    for (const schema of ['access', 'commerce', 'quota', 'site'])
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    for (const sql of oldMigrations) await client.query(sql);
  };
  try {
    await recreate();
    await client.query(
      `INSERT INTO access.principal(id,account_issuer,account_subject) VALUES ($1,'g1023','restored')`,
      [principal],
    );
    await client.query(
      `INSERT INTO access.name_registry(scope,key,display,skeleton,holder,controller,state,revision)
      VALUES ('work','café-au-lait','Café Au Lait','café-au-lait',$1,$1,'current',$2),
        ('work','old-alias','Old Alias','old-alias',$1,$1,'redirect',$3)`,
      [holder, revision, previous],
    );
    await client.query(`INSERT INTO access.name_history(revision,scope,key,holder,display,state)
      SELECT revision,scope,key,holder,display,state FROM access.name_registry`);
    await client.query(
      `INSERT INTO access.name_receipt(principal_id,idempotency_key,request_digest,result)
      VALUES ($1,'claim','digest',$2)`,
      [
        principal,
        {
          profile: 'name-write-v1',
          scope: 'work',
          holder,
          key: 'café-au-lait',
          display: 'Café Au Lait',
          revision,
          state: 'current',
          previousKey: null,
          changedAt: new Date().toISOString(),
          replayed: false,
        },
      ],
    );
    await client.query(
      `INSERT INTO access.name_graph_import(data_epoch,cursor) VALUES ('g1023','retained-cursor')`,
    );
    await client.query(
      `INSERT INTO access.name_graph_import_report(data_epoch,source,reason,legacy_name)
      VALUES ('g1023','source','retry',$1)`,
      [{ key: { value: 'Café Au Lait' } }],
    );
    const backup = new Map<string, unknown[]>();
    for (const table of ['principal', ...registryTables]) {
      backup.set(table, (await client.query(`SELECT * FROM access.${table}`)).rows);
    }
    await recreate();
    for (const [table, rows] of backup) {
      if (!rows.length) continue;
      await client.query(
        `INSERT INTO access.${table} SELECT * FROM jsonb_populate_recordset(NULL::access.${table},$1)
        ON CONFLICT DO NOTHING`,
        [JSON.stringify(rows)],
      );
    }
    await client.query(migration);
    const head = (await client.query(`SELECT * FROM access.alias_registry ORDER BY key`)).rows;
    const history = (await client.query(`SELECT * FROM access.alias_history ORDER BY key`)).rows;
    expect(head.map((row) => row.holder)).toEqual([holder, holder]);
    expect(head.map((row) => row.revision)).toEqual([revision, previous]);
    for (const row of [...head, ...history]) expect(row).not.toHaveProperty('display');
    expect(
      (
        await client.query(`SELECT result FROM access.alias_receipt WHERE principal_id = $1`, [
          principal,
        ])
      ).rows[0].result,
    ).toMatchObject({ profile: 'alias-write-v1', key: 'café-au-lait', revision });
    expect(
      (await client.query(`SELECT result FROM access.alias_receipt`)).rows[0].result,
    ).not.toHaveProperty('display');
    expect(
      (
        await client.query(
          `SELECT cursor FROM access.alias_graph_import WHERE data_epoch = 'g1023'`,
        )
      ).rows[0].cursor,
    ).toBe('retained-cursor');
    expect(
      (await client.query(`SELECT legacy_alias FROM access.alias_graph_import_report`)).rows[0]
        .legacy_alias,
    ).toEqual({ key: { value: 'Café Au Lait' } });
    await client.query(migration);
    expect((await client.query(`SELECT * FROM access.alias_registry ORDER BY key`)).rows).toEqual(
      head,
    );
    expect((await client.query(`SELECT * FROM access.alias_history ORDER BY key`)).rows).toEqual(
      history,
    );
    for (const table of registryTables)
      expect(
        (await client.query('SELECT to_regclass($1) AS relation', [`access.${table}`])).rows[0]
          .relation,
      ).toBeNull();
    await client.query('BEGIN');
    const rejected = async (sql: string, values: unknown[] = []) => {
      await client.query('SAVEPOINT denied');
      try {
        await expect(client.query(sql, values)).rejects.toMatchObject({ code: '23514' });
      } finally {
        await client.query('ROLLBACK TO SAVEPOINT denied');
      }
    };
    for (const key of [
      uuidToSid(randomUUID()),
      `${uuidToSid(randomUUID())}-suffix`,
      randomUUID(),
    ]) {
      await rejected(
        `INSERT INTO access.alias_registry(scope,key,skeleton,holder,controller,state)
        VALUES ('work',$1,$1,$2,$2,'current')`,
        [key, other],
      );
    }
    await rejected(`UPDATE access.alias_registry SET holder = $1 WHERE key = 'café-au-lait'`, [
      other,
    ]);
    await rejected(`DELETE FROM access.alias_registry WHERE key = 'old-alias'`);
    await rejected(`UPDATE access.alias_history SET state = 'retired' WHERE revision = $1`, [
      revision,
    ]);
    const constraints = (
      await client.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid IN ('access.alias_registry'::regclass,'access.alias_history'::regclass)`)
    ).rows;
    expect(constraints.some((row) => row.definition.includes('display'))).toBe(false);
    for (const name of [
      'alias_registry_current_holder',
      'alias_registry_holder_head',
      'alias_registry_skeleton',
      'alias_registry_handle_skeleton',
      'alias_history_alias',
      'realm_member_alias_registry_search',
      'alias_graph_import_pending',
    ]) {
      expect(
        (await client.query('SELECT to_regclass($1) AS relation', [`access.${name}`])).rows[0]
          .relation,
      ).not.toBeNull();
    }
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
}, 60_000);

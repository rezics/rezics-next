import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SqlSource } from '../../../scripts/qa/sql-relations.ts';
import {
  repositorySerializationSources,
  repositorySerializationMigrations,
  serializationAllowlist,
  serializationFindings,
  singletonTables,
  type SerializationAllowance,
} from '../../../scripts/qa/serialization-points.ts';

const migration = (text: string): SqlSource => ({
  file: 'services/example/migrations/001.sql',
  text,
});
const source = (text: string): SqlSource => ({
  file: 'services/example/src/routes/write.ts',
  text,
});
const table = migration(
  'CREATE TABLE probe.head (id boolean PRIMARY KEY CHECK (id), version bigint);',
);
const allowance: SerializationAllowance = {
  relation: 'probe.head',
  class: 'projection checkpoint (background)',
  reason: 'Background fold owns this cursor.',
  writers: [table.file, 'services/example/src/fold.ts'],
};

test('singleton DDL detects inline and table keys, fixed keys, and constant unique indexes', () => {
  const inventory = singletonTables([
    migration(`
    -- CREATE TABLE probe.comment_only(id boolean PRIMARY KEY CHECK(id));
    CREATE TABLE probe.inline (id boolean PRIMARY KEY CHECK (id));
    CREATE TABLE "probe"."TableKey" (singleton bool CHECK(singleton), PRIMARY KEY(singleton));
    CREATE TABLE probe.fixed (name text PRIMARY KEY CHECK(name = 'only'));
    CREATE TABLE probe.numeric (id int CHECK(id = 1), UNIQUE(id));
    CREATE TABLE probe.composite (a int CHECK(a = 1), b text CHECK(b = 'only'), PRIMARY KEY(a,b));
    CREATE TABLE probe.indexed (value text);
    CREATE UNIQUE INDEX one_row ON probe.indexed ((true));
    CREATE TABLE probe.signing_keys (id uuid PRIMARY KEY, state text);
    CREATE UNIQUE INDEX one_active ON probe.signing_keys ((true)) WHERE state='active';
    CREATE TABLE probe.objects(id text PRIMARY KEY);
    CREATE TABLE probe.per_object(singleton bool CHECK(singleton), owner text, PRIMARY KEY(owner,singleton));
    CREATE TABLE probe.not_fixed(id int PRIMARY KEY CHECK(id > 0));
    CREATE TABLE probe.not_single(id int, kind text CHECK(kind = 'only'), PRIMARY KEY(id,kind));
  `),
  ]);
  expect([...inventory.keys()]).toEqual([
    'probe.inline',
    'probe.TableKey',
    'probe.fixed',
    'probe.numeric',
    'probe.composite',
    'probe.indexed',
  ]);
  expect(serializationFindings([table], [], []).map((finding) => finding.rule)).toEqual([
    'singleton-table',
  ]);
});

test('advisory keys distinguish per-object values from literal, numeric and bound constants', () => {
  const findings = serializationFindings(
    [],
    [
      source(`
    // db.query("SELECT pg_advisory_lock(99)");
    const fixed = 'platform-head';
    db.query("SELECT pg_advisory_xact_lock(hashtextextended('platform',0))");
    db.query('SELECT pg_advisory_lock(42)');
    db.query('SELECT pg_advisory_xact_lock($1, $2)', [1, 2]);
    db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [fixed]);
    db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [object.id]);
    db.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [\`object:\${object.id}\`]);
    db.query("SELECT pg_advisory_xact_lock(hashtextextended('object:' || $1,0))", [object.id]);
    db.query(\`SELECT pg_advisory_xact_lock(\${42})\`);
  `),
    ],
    [],
  );
  expect(findings.map((finding) => finding.target)).toEqual([
    'platform',
    '42',
    '"1" , "2"',
    'platform-head',
    '42',
  ]);
  expect(
    serializationFindings(
      [
        migration(`DO $$ BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('fixed',0));
    PERFORM pg_advisory_xact_lock(hashtextextended('item:' || NEW.id,0));
  END $$;`),
      ],
      [],
      [],
    ).map((finding) => finding.target),
  ).toEqual(['fixed']);
});

test('constant parameter arrays and interpolated negative advisory keys are rejected', () => {
  const findings = serializationFindings(
    [],
    [
      source(`
    const key = 'global';
    const parameters = [key];
    db.query('SELECT pg_advisory_xact_lock(hashtext($1))', parameters);
    db.query(\`SELECT pg_advisory_lock(\${-42})\`);
  `),
    ],
    [],
  );
  expect(findings.map((finding) => finding.target)).toEqual(['global', '- 42']);
});

test('new route UPDATE, upsert and exclusive singleton locks need their own approved writer', () => {
  const text = `
    db.query('UPDATE probe.head SET version = $1', [version]);
    db.query('SELECT * FROM probe.head FOR UPDATE');
    db.query('SELECT * FROM probe.head FOR NO KEY UPDATE');
    db.query('INSERT INTO probe.head(id) VALUES(true) ON CONFLICT(id) DO UPDATE SET version=1');
    db.query('SELECT * FROM probe.head FOR SHARE');
  `;
  expect(
    serializationFindings([table], [source(text)], [allowance]).map((finding) => finding.rule),
  ).toEqual(Array(4).fill('singleton-write'));
  expect(
    serializationFindings([table], [{ file: allowance.writers[1], text }], [allowance]),
  ).toEqual([]);
});

test('FOR UPDATE OF another row does not exclusively lock a joined singleton', () => {
  expect(
    serializationFindings(
      [table],
      [
        source(`db.query(\`SELECT c.id FROM probe.cursor c
    CROSS JOIN probe.head h WHERE h.id FOR UPDATE OF c\`);`),
      ],
      [allowance],
    ),
  ).toEqual([]);
  expect(
    serializationFindings(
      [table],
      [source(`db.query('SELECT * FROM "probe"."head" h FOR UPDATE OF h');`)],
      [allowance],
    )[0]?.rule,
  ).toBe('singleton-write');
});

test('aliased UPDATE targets and comma-separated singleton lock targets are audited', () => {
  const findings = serializationFindings(
    [table],
    [
      source(`
    db.query('UPDATE probe.head AS h SET version=1');
    db.query('UPDATE probe.head h SET version=2');
    db.query('SELECT * FROM probe.objects o, probe.head h FOR UPDATE OF h');
  `),
    ],
    [allowance],
  );
  expect(findings.map((finding) => finding.rule)).toEqual(Array(3).fill('singleton-write'));
});

test('gate share then update is never exempted, but distinct keys and transactions do not collide', () => {
  const findings = serializationFindings(
    [],
    [
      source(`
    async function unsafe(client, gate) {
      await client.query('SELECT id FROM probe.scope_gate WHERE id=$1 FOR SHARE', [gate]);
      await client.query('UPDATE probe.scope_gate SET open=false WHERE id=$1', [gate]);
    }
    async function separate(client) {
      await client.query("SELECT id FROM probe.scope_gate WHERE id='a' FOR SHARE");
      await client.query("UPDATE probe.scope_gate SET open=false WHERE id='b'");
      await client.query('COMMIT');
      await client.query("UPDATE probe.scope_gate SET open=false WHERE id='a'");
    }
    async function reader(client) { await client.query('SELECT * FROM probe.scope_gate FOR SHARE'); }
    async function writer(client) { await client.query('UPDATE probe.scope_gate SET open=false'); }
  `),
    ],
    [],
  );
  expect(findings.map((finding) => finding.rule)).toEqual(['gate-lock-upgrade']);
});

test('module-level transaction paths cannot share then update a gate', () => {
  expect(
    serializationFindings(
      [],
      [
        source(`
    await client.query('BEGIN');
    await client.query("SELECT id FROM probe.scope_gate WHERE id='a' FOR SHARE");
    await client.query("UPDATE probe.scope_gate SET open=false WHERE id='a'");
  `),
      ],
      [],
    ).map((finding) => finding.rule),
  ).toEqual(['gate-lock-upgrade']);
});

test('gate upgrades follow imported helpers, callbacks and method calls with substituted keys', () => {
  const findings = serializationFindings(
    [],
    [
      {
        file: 'services/example/src/gates.ts',
        text: `
      export async function share(client, scope) {
        await client.query('SELECT id FROM probe.scope_gate WHERE id=$1 FOR SHARE', [scope]);
      }
      export async function change(client, scope) {
        await client.query('UPDATE probe.scope_gate SET open=false WHERE id=$1', [scope]);
      }
    `,
      },
      source(`import { share as pin, change } from '../gates.ts';
      async function unsafe(pool, object) {
        return transaction(pool, async client => {
          await pin(client, object.id);
          await change(client, object.id);
        });
      }
      async function separate(client) {
        await pin(client, 'a');
        await change(client, 'b');
      }
      class Store {
        async pin(client, key) { await client.query('SELECT id FROM probe.scope_gate WHERE id=$1 FOR SHARE', [key]); }
        async write(client, key) {
          await this.pin(client, key);
          await client.query('UPDATE probe.scope_gate SET open=false WHERE id=$1', [key]);
        }
      }
    `),
    ],
    [],
  );
  expect(findings.every((finding) => finding.rule === 'gate-lock-upgrade')).toBe(true);
  expect(new Set(findings.map((finding) => finding.file))).toEqual(
    new Set(['services/example/src/gates.ts', 'services/example/src/routes/write.ts']),
  );
});

test('migration gate upgrades are checked per SQL function and cannot be allowlisted', () => {
  const findings = serializationFindings(
    [
      migration(`
    CREATE FUNCTION probe.unsafe() RETURNS void LANGUAGE plpgsql AS $$ BEGIN
      PERFORM 1 FROM probe.scope_gate WHERE id='a' FOR SHARE;
      UPDATE probe.scope_gate SET open=false WHERE id='a';
    END $$;
    CREATE FUNCTION probe.reader() RETURNS void LANGUAGE plpgsql AS $$ BEGIN
      PERFORM 1 FROM probe.scope_gate WHERE id='b' FOR SHARE;
    END $$;
    CREATE FUNCTION probe.writer() RETURNS void LANGUAGE plpgsql AS $$ BEGIN
      UPDATE probe.scope_gate SET open=false WHERE id='b';
    END $$;
  `),
    ],
    [],
    [
      {
        relation: 'probe.scope_gate',
        class: 'operator/startup',
        reason: 'Operator fence.',
        writers: [migration('').file],
      },
    ],
  );
  expect(findings.map((finding) => finding.rule)).toEqual(['gate-lock-upgrade']);
});

test('conditional helper locks and transaction callback execution preserve exclusive fences', () => {
  const make = (write: boolean) =>
    source(`
    async function lock(client, scope, write = true) {
      await client.query(\`SELECT id FROM probe.scope_gate WHERE id=$1 FOR \${write ? 'UPDATE' : 'SHARE'}\`, [scope]);
    }
    async function transaction(client, run) {
      await client.query('BEGIN');
      await lock(client, 'a', ${write});
      await run(client);
      await client.query('COMMIT');
    }
    async function write(client) {
      await transaction(client, async db => {
        await db.query("SELECT id FROM probe.scope_gate WHERE id='a' FOR SHARE");
        await db.query("UPDATE probe.scope_gate SET open=false WHERE id='a'");
      });
    }
  `);
  expect(serializationFindings([], [make(true)], [])).toEqual([]);
  expect(
    serializationFindings([], [make(false)], []).some(
      (finding) => finding.rule === 'gate-lock-upgrade',
    ),
  ).toBe(true);
  const afterShare = source(`async function unsafe(client) {
    await client.query("SELECT id FROM probe.scope_gate WHERE id='a' FOR SHARE");
    await client.query("SELECT id FROM probe.scope_gate WHERE id='a' FOR UPDATE");
    await client.query("UPDATE probe.scope_gate SET open=false WHERE id='a'");
  }`);
  expect(serializationFindings([], [afterShare], []).map((finding) => finding.rule)).toEqual([
    'gate-lock-upgrade',
  ]);
});

test('transaction callbacks retain captured object keys through nested helpers', () => {
  expect(
    serializationFindings(
      [],
      [
        source(`
    async function transaction(client, key, run) {
      await client.query('BEGIN');
      await client.query('SELECT id FROM probe.scope_gate WHERE id=$1 FOR UPDATE', [key]);
      await run(client);
      await client.query('COMMIT');
    }
    async function write(client, key) {
      await transaction(client, key, async db => {
        await db.query('SELECT id FROM probe.scope_gate WHERE id=$1 FOR SHARE', [key]);
        await db.query('UPDATE probe.scope_gate SET open=false WHERE id=$1', [key]);
      });
    }
    async function command(client, object) {
      const key = await resolveGate(object);
      await write(client, key);
    }
  `),
      ],
      [],
    ),
  ).toEqual([]);
});

test('mutually exclusive policy branches cannot combine SHARE and a gate update', () => {
  expect(
    serializationFindings(
      [],
      [
        source(`
    async function lock(client, key, write) {
      await client.query(\`SELECT id FROM probe.scope_gate WHERE id=$1 FOR \${write ? 'UPDATE' : 'SHARE'}\`, [key]);
    }
    async function change(client, action) {
      const changesPolicy = action === 'publish' || action === 'end';
      await lock(client, 'scope', changesPolicy);
      if (action === 'publish') await client.query("UPDATE probe.scope_gate SET open=false WHERE id='scope'");
      else if (action === 'end') await client.query("UPDATE probe.scope_gate SET open=false WHERE id='scope'");
    }
  `),
      ],
      [],
    ),
  ).toEqual([]);
});

test('gate upgrades include current database functions and triggers, replacing historical bodies', () => {
  const ddl = migration(`
    CREATE TABLE probe.objects(id text PRIMARY KEY);
    CREATE FUNCTION probe.bump_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      UPDATE probe.scope_gate SET revision=revision+1 WHERE id='a';
      RETURN NEW;
    END $$;
    CREATE TRIGGER gate_revision AFTER UPDATE ON probe.objects FOR EACH ROW EXECUTE FUNCTION probe.bump_gate();
  `);
  const path = source(`async function unsafe(client) {
    await client.query("SELECT id FROM probe.scope_gate WHERE id='a' FOR SHARE");
    await client.query("UPDATE probe.objects SET id='b' WHERE id='c'");
  }`);
  expect(serializationFindings([ddl], [path], []).map((finding) => finding.rule)).toEqual([
    'gate-lock-upgrade',
  ]);
  const replacement = {
    ...migration(
      `CREATE OR REPLACE FUNCTION probe.bump_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`,
    ),
    file: 'services/example/migrations/002.sql',
  };
  expect(serializationFindings([ddl, replacement], [path], [])).toEqual([]);
  const direct = source(`async function unsafe(client) {
    await client.query("SELECT id FROM probe.scope_gate WHERE id='a' FOR SHARE");
    await client.query('SELECT probe.bump_gate()');
  }`);
  expect(serializationFindings([ddl], [direct], []).map((finding) => finding.rule)).toEqual([
    'gate-lock-upgrade',
  ]);
});

test('template alternatives and SQL constants retain the surrounding write operation', () => {
  const findings = serializationFindings(
    [table],
    [
      source(`
    const query = 'UPDATE probe.head SET version=1';
    db.query(query);
    db.query(\`UPDATE probe.\${legacy ? 'head' : 'objects'} SET version=1\`);
  `),
    ],
    [allowance],
  );
  expect(
    findings.filter((finding) => finding.rule === 'singleton-write').length,
  ).toBeGreaterThanOrEqual(2);
});

test('comments, SQL strings containing prose, aliases and SQL literals cannot invent writes', () => {
  expect(
    serializationFindings(
      [table],
      [
        source(`
    // client.query('UPDATE probe.head SET version=1');
    const prose = 'A FOR UPDATE on probe.head must be approved';
    db.query("SELECT 'UPDATE probe.head SET version=1', h.version FROM probe.head h");
  `),
      ],
      [allowance],
    ),
  ).toEqual([]);
});

test('allowances require an exact relation or key, writer and reason', () => {
  for (const invalid of [
    { ...allowance, reason: '' },
    { ...allowance, key: 'also' },
    { ...allowance, writers: [] },
  ]) {
    expect(() => serializationFindings([], [], [invalid])).toThrow(
      'Serialization allowance requires',
    );
  }
  expect(serializationAllowlist.every((entry) => entry.reason.trim() && entry.writers.length)).toBe(
    true,
  );
});

test('discovery audits unregistered services and orders nested migrations numerically', () => {
  const root = resolve(import.meta.dir, '../../..');
  const fixture = mkdtempSync(join(root, '.temp/serialization-discovery-'));
  try {
    const directory = join(fixture, 'services/future/migrations/nested');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, '1200_head.sql'), 'SELECT 1;');
    writeFileSync(
      join(directory, '900_base.sql'),
      'CREATE TABLE probe.new_head(id boolean PRIMARY KEY CHECK(id));',
    );
    expect(repositorySerializationMigrations(fixture).map((source) => source.file)).toEqual([
      'services/future/migrations/nested/900_base.sql',
      'services/future/migrations/nested/1200_head.sql',
    ]);
    expect(
      serializationFindings(repositorySerializationMigrations(fixture), [], []).map(
        (finding) => finding.rule,
      ),
    ).toEqual(['singleton-table']);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('service migrations and write paths introduce no unapproved serialization or gate upgrades', () => {
  const root = resolve(import.meta.dir, '../../..');
  const findings = serializationFindings(
    repositorySerializationMigrations(root),
    repositorySerializationSources(root),
  );
  expect(
    findings.map(
      (finding) =>
        `${finding.file}:${finding.line}: ${finding.rule}: ${finding.target}: ${finding.detail}`,
    ),
  ).toEqual([]);
}, 30_000);

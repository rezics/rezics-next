// sql-relations-allow: access.old -- Synthetic rename and drop fixtures deliberately reference removed relations.
// sql-relations-allow: access.current -- Synthetic rename fixture moves this relation to another owner schema.
// sql-relations-allow: access.gone -- Synthetic drop fixture deliberately removes this relation.
// sql-relations-allow: access.also_gone -- Synthetic comma-separated drop fixture removes this relation.
// sql-relations-allow: reader.Books -- Synthetic quoted-identifier fixture preserves case.
// sql-relations-allow: content.counter -- Synthetic sequence fixture tests relation extraction.
// sql-relations-allow: access.name_registry -- Synthetic migration fixture and captured pre-fix query prove the regression.
// sql-relations-allow: access.name_history -- Synthetic finite-rename fixture tests historical vocabulary.
// sql-relations-allow: access.live -- Synthetic SQL extraction fixture tests relation positions.
// sql-relations-allow: reader.books -- Synthetic SQL extraction fixture tests comma-separated FROM.
// sql-relations-allow: source.capture -- Synthetic SQL extraction fixture tests JOIN.
// sql-relations-allow: relay.missing -- Synthetic SQL extraction fixture deliberately names a missing relation.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { getAuthTables } from '@better-auth/core/db';
import { accountAuthOptions } from '../../../services/account/src/auth.ts';
import {
  migratedRelations,
  migrationSchemas,
  migrationSources,
  missingRelations,
  relationExemptions,
  repositorySqlSources,
  sourceRelations,
  sourceSqlLiterals,
} from '../../../scripts/qa/sql-relations.ts';

const root = resolve(import.meta.dir, '../../..');
const schemas = new Set(['access', 'content', 'relay', 'reader', 'source', 'pkg']);

test('G1046: relation inventory follows numeric migrations, views, sequences, renames and drops', () => {
  const relations = migratedRelations([
    {
      file: 'fixture.sql',
      text: `
    -- CREATE TABLE access.comment_only(id int);
    CREATE TABLE access.old(id int); CREATE TABLE "reader"."Books"(id int);
    CREATE TABLE access.gone(id int); CREATE TABLE access.also_gone(id int);
    ALTER TABLE access.old RENAME COLUMN id TO other;
    ALTER TABLE access.old RENAME TO current;
    CREATE VIEW access.old AS SELECT * FROM access.current;
    CREATE SEQUENCE content.counter;
    CREATE UNIQUE INDEX IF NOT EXISTS head_lookup ON access.current(other);
    DROP TABLE access.gone, access.also_gone;
    ALTER TABLE access.current SET SCHEMA reader;
    DROP VIEW access.old;
  `,
    },
  ]);
  expect([...relations].sort()).toEqual([
    'access.head_lookup',
    'content.counter',
    'reader.Books',
    'reader.current',
  ]);
  expect(
    missingRelations(
      [{ file: 'query.ts', text: "db.query('SELECT * FROM access.old')" }],
      relations,
      schemas,
    ),
  ).toEqual([{ file: 'query.ts', line: 1, relation: 'access.old' }]);
});

test('G1046: finite dynamic rename DDL removes former names and unsupported dynamic DDL fails', () => {
  const relations = migratedRelations([
    {
      file: 'rename.sql',
      text: `
    CREATE TABLE access.name_registry(id int); CREATE TABLE access.name_history(id int);
    DO $$ BEGIN FOREACH former IN ARRAY ARRAY['name_registry','name_history'] LOOP
      EXECUTE format('ALTER TABLE access.%I RENAME TO %I', former, replace(former,'name_','alias_'));
    END LOOP; END $$;
    DROP TABLE access.alias_history;
  `,
    },
  ]);
  expect([...relations]).toEqual(['access.alias_registry']);
  expect(() =>
    migratedRelations([
      {
        file: 'unknown.sql',
        text: `DO $$ BEGIN
    EXECUTE format('ALTER TABLE access.%I RENAME TO %I', unknown, other);
    END $$;`,
      },
    ]),
  ).toThrow('unknown.sql: unsupported dynamic relation DDL');
  expect(() =>
    migratedRelations([
      {
        file: 'concat.sql',
        text: "EXECUTE 'ALTER TABLE access.' || unknown || ' RENAME TO renamed';",
      },
    ]),
  ).toThrow('concat.sql: unsupported dynamic relation DDL');
  expect([
    ...migratedRelations([
      { file: 'literal.sql', text: "EXECUTE 'CREATE TABLE access.live(id int)';" },
    ]),
  ]).toEqual(['access.live']);
});

test('G1046: COPY, maintenance and grant/index/trigger targets are relation positions', () => {
  const source = {
    file: 'query.ts',
    text: `db.query(\`COPY access.live TO STDOUT;
    ANALYZE reader.books; VACUUM access.live;
    GRANT SELECT ON access.live TO role;
    CREATE INDEX lookup ON access.live(id);
    CREATE TRIGGER guard BEFORE DELETE ON access.live EXECUTE FUNCTION access.guard();
    SELECT access.old FROM access.live JOIN reader.books ON access.column = reader.column\`);`,
  };
  expect(sourceRelations(source, schemas).map((ref) => ref.relation)).toEqual([
    'access.live',
    'reader.books',
    'access.live',
    'access.live',
    'access.live',
    'access.live',
    'access.live',
    'reader.books',
  ]);
});

test('G1046: source extraction reports lines and ignores comments, columns and SQL functions', () => {
  const source = {
    file: 'query.ts',
    text: `
    // db.query('SELECT * FROM access.comment_only');
    const irrelevant = 'access.column is descriptive prose';
    db.query(\`SELECT access.some_column, content.other_column FROM access.live AS a,
      reader.books b JOIN source.capture s ON true
      WHERE a.id = \${value} AND EXISTS (SELECT 1 FROM relay.missing)\`);
    db.query('SELECT * FROM access.function_call($1)');
    db.query('SELECT access.is_address_sid($1)');
    db.query("SELECT nextval('content.counter')");
    const dynamicTable = "pkg.artifact";
  `,
  };
  expect(sourceRelations(source, schemas)).toEqual([
    { file: 'query.ts', line: 4, relation: 'access.live' },
    { file: 'query.ts', line: 5, relation: 'reader.books' },
    { file: 'query.ts', line: 5, relation: 'source.capture' },
    { file: 'query.ts', line: 6, relation: 'relay.missing' },
    { file: 'query.ts', line: 9, relation: 'content.counter' },
    { file: 'query.ts', line: 10, relation: 'pkg.artifact' },
  ]);
});

test('G1046: interpolated values preserve static relations and partial names are not real tables', () => {
  const text =
    'db.query(`INSERT INTO access.live(id) VALUES (${id});\n' +
    'SELECT * FROM public."${table}" JOIN access.probe_${nonce} p ON true;\n' +
    'UPDATE access.live SET id = ${next} WHERE id IN (SELECT id FROM reader.books)`);';
  expect(sourceRelations({ file: 'query.ts', text }, new Set([...schemas, 'public']))).toEqual([
    { file: 'query.ts', line: 1, relation: 'access.live' },
    { file: 'query.ts', line: 3, relation: 'access.live' },
    { file: 'query.ts', line: 3, relation: 'reader.books' },
  ]);
  expect(
    sourceRelations(
      {
        file: 'query.ts',
        text: 'db.query("SELECT * FROM \\"access\\".\\"live\\"; SELECT to_regclass(\'public.\\"user\\"\')")',
      },
      new Set([...schemas, 'public']),
    ).map((ref) => ref.relation),
  ).toEqual(['access.live', 'public.user']);
});

test('G1046: literal relation alternatives in SQL interpolation are checked on every branch', () => {
  expect(
    sourceRelations(
      {
        file: 'query.ts',
        text: "db.query(`SELECT * FROM access.${legacy ? 'old' : 'live'};\nSELECT * FROM ${legacy ? 'access.old' : 'reader.books'}`)",
      },
      schemas,
    ),
  ).toEqual([
    { file: 'query.ts', line: 1, relation: 'access.old' },
    { file: 'query.ts', line: 1, relation: 'access.live' },
    { file: 'query.ts', line: 2, relation: 'access.old' },
    { file: 'query.ts', line: 2, relation: 'reader.books' },
  ]);
});

test('G1046: quoted owner names survive source escapes and SQL whitespace', () => {
  const sql = 'SELECT * FROM "access" . "live"';
  expect(
    sourceRelations({ file: 'query.ts', text: `db.query(${JSON.stringify(sql)})` }, schemas),
  ).toEqual([{ file: 'query.ts', line: 1, relation: 'access.live' }]);
});

test('G1046: exemptions require exact names, reasons and real test comments', () => {
  const declaration =
    '// sql-relations-allow: access.old -- Restores a historical migration cut.\n';
  expect([
    ...relationExemptions({ file: 'migration.test.ts', text: declaration + 'const query = 1;' }),
  ]).toEqual([['access.old', 'Restores a historical migration cut.']]);
  expect(() =>
    relationExemptions({ file: 'service.ts', text: declaration + 'const query = 1;' }),
  ).toThrow('requires a test file, exact relation and reason');
  expect(() =>
    relationExemptions({
      file: 'migration.test.ts',
      text: '// sql-relations-allow: access.* -- historical\nconst query = 1;',
    }),
  ).toThrow('requires a test file, exact relation and reason');
  expect(() =>
    relationExemptions({
      file: 'migration.test.ts',
      text: '// sql-relations-allow: access.old\nconst query = 1;',
    }),
  ).toThrow('requires a test file, exact relation and reason');
  expect(
    relationExemptions({
      file: 'migration.test.ts',
      text: `const data = ${JSON.stringify(declaration)};`,
    }).size,
  ).toBe(0);
  expect(
    missingRelations(
      [
        {
          file: 'migration.test.ts',
          text: declaration + "db.query('SELECT * FROM access.unexpected')",
        },
      ],
      new Set(),
      schemas,
    ),
  ).toEqual([{ file: 'migration.test.ts', line: 2, relation: 'access.unexpected' }]);
});

test('G1046: discovery includes every owner schema even when its relations were dropped', () => {
  const migrations = [
    {
      file: 'fixture.sql',
      text: 'CREATE SCHEMA future_owner; CREATE TABLE future_owner.old(id int); DROP SCHEMA future_owner CASCADE;',
    },
  ];
  expect(
    missingRelations(
      [{ file: 'query.ts', text: "db.query('SELECT * FROM future_owner.old')" }],
      migratedRelations(migrations),
      migrationSchemas(migrations),
    ),
  ).toEqual([{ file: 'query.ts', line: 1, relation: 'future_owner.old' }]);
});

test('G1046: every SQL relation in services, scripts and tests exists at the migration head', () => {
  const migrations = migrationSources(root);
  const sources = repositorySqlSources(root);
  const runners = sources.filter((source) =>
    ['scripts/ops/migrate.ts', 'services/content/src/migrate.ts'].includes(source.file),
  );
  const relations = migratedRelations([...runners.flatMap(sourceSqlLiterals), ...migrations]);
  // Better Auth builds its migration plan from the same plugin/options schema.
  // Inspect that schema without connecting to a database or starting a service.
  const pool = new Pool();
  const provider = getAuthTables(
    accountAuthOptions({
      baseURL: 'http://127.0.0.1:3002',
      secret: 'g1046-schema-inventory-only-secret',
      resource: 'http://127.0.0.1:3001',
      pool,
      operatorUserIds: new Set(),
    }),
  );
  for (const table of Object.values(provider))
    if (!table.disableMigrations) relations.add(`public.${table.modelName}`);
  const ownerSchemas = migrationSchemas(migrations);
  expect(relations.has('access.alias_registry')).toBe(true);
  expect(relations.has('access.name_registry')).toBe(false);
  expect(relations.has('access.agent_handle')).toBe(false);
  const missing = sources.flatMap((source) => {
    const exempt = relationExemptions(source);
    return missingRelations([source], relations, ownerSchemas).filter(
      (ref) => !exempt.has(ref.relation),
    );
  });
  expect(missing.map((ref) => `${ref.file}:${ref.line}: ${ref.relation}`)).toEqual([]);
}, 15_000);

test('G1046: the guard catches the actual name_registry query on the parent of the feed fix', () => {
  // Exact source captured with git show 6a5793b7d^:services/main/src/modules/feed/frame.ts.
  // Keep the regression runnable in shallow CI checkouts without the old commit.
  const text = readFileSync(resolve(import.meta.dir, 'g-1046-parent-frame.ts.txt'), 'utf8');
  const missing = missingRelations(
    [{ file: 'services/main/src/modules/feed/frame.ts', text }],
    migratedRelations(migrationSources(root)),
    schemas,
  );
  expect(missing).toEqual([
    {
      file: 'services/main/src/modules/feed/frame.ts',
      line: 27,
      relation: 'access.name_registry',
    },
  ]);
});

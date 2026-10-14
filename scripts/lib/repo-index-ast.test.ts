// sql-relations-allow: access.live -- Synthetic indexed SQL fixture names an example relation.
// sql-relations-allow: access.missing -- Synthetic indexed SQL fixture names a missing relation.
import { expect, test } from 'bun:test';
import ts from 'typescript-6';
import { indexedOffsets, indexedSourceNodes } from './repo-index-ast.ts';
import { relationExemptions, sourceRelations, sourceSqlLiterals } from '../qa/sql-relations.ts';
import { serializationFindings } from '../qa/serialization-points.ts';

const schemas = new Set(['access']);

test('indexed syntax handles Unicode and interpolation trivia', () => {
  const text =
    'const label = "阅读";\n' +
    'db.query(`SELECT * FROM access.live\n WHERE id = ${ value /* } */ }\n' +
    'AND EXISTS(SELECT 1 FROM access.missing)`);';
  expect(sourceRelations({ file: 'probe.ts', text }, schemas)).toEqual([
    { file: 'probe.ts', line: 2, relation: 'access.live' },
    { file: 'probe.ts', line: 4, relation: 'access.missing' },
  ]);
});

test('indexed lexical comments preserve exemptions and ignore literals', () => {
  const text =
    "const x = 'sql-relations-allow: access.fake -- string';\n" +
    '// sql-relations-allow: access.live -- Deliberate probe.\nconst y=1;';
  expect([...relationExemptions({ file: 'probe.test.ts', text })]).toEqual([
    ['access.live', 'Deliberate probe.'],
  ]);
});

test('indexed extraction does not emit SQL chunks from interpolated templates', () => {
  expect(
    sourceSqlLiterals({
      file: 'probe.ts',
      text: 'const q=`SELECT * FROM access.${table}`;',
    }),
  ).toEqual([]);
});

test('interpolation comments cannot hide a following relation on the same line', () => {
  const text =
    'db.query(`SELECT * FROM access.live WHERE id=${ /* ${ */ value /* } -- */ } ' +
    'AND EXISTS(SELECT 1 FROM access.missing)`);';
  expect(
    sourceRelations({ file: 'probe.ts', text }, schemas).map((reference) => reference.relation),
  ).toEqual(['access.live', 'access.missing']);
});

test('native byte offsets map across sparse Unicode boundaries', () => {
  const offset = indexedOffsets('abcé中😀z');
  expect([0, 3, 5, 8, 12, 13].map(offset)).toEqual([0, 3, 4, 5, 7, 8]);
});

test('constructor, accessor and parameter-property views preserve TypeScript names', () => {
  const nodes = indexedSourceNodes({
    file: 'class.ts',
    text: 'class Control { constructor(public readonly db: unknown) {} get value() { return 1; } set value(next: number) {} }',
  }).filter(ts.isFunctionLike);
  expect(nodes.map((node) => node.kind)).toEqual([
    ts.SyntaxKind.Constructor,
    ts.SyntaxKind.GetAccessor,
    ts.SyntaxKind.SetAccessor,
  ]);
  expect('name' in nodes[0]).toBe(false);
  expect(nodes[0].parameters[0].name.getText()).toBe('db');
});

test('interpolated schema alternatives remain visible to relation rules', () => {
  expect(
    sourceRelations(
      {
        file: 'probe.ts',
        text: "db.query(`SELECT * FROM ${active ? 'access' : 'other'}.missing`)",
      },
      schemas,
    ),
  ).toEqual([{ file: 'probe.ts', line: 1, relation: 'access.missing' }]);
});

test('SQL literals in type declarations retain relation rules and positions', () => {
  expect(
    sourceRelations(
      {
        file: 'probe.ts',
        text: "type Query =\n  'SELECT * FROM access.missing';",
      },
      schemas,
    ),
  ).toEqual([{ file: 'probe.ts', line: 2, relation: 'access.missing' }]);
});

test('SQL literals in type declarations retain advisory-key rules', () => {
  expect(
    serializationFindings(
      [],
      [
        {
          file: 'probe.ts',
          text: "type Query = 'SELECT pg_advisory_lock(12)';",
        },
      ],
      [],
    ).map((finding) => [finding.rule, finding.target, finding.line]),
  ).toEqual([['constant-advisory-key', '12', 1]]);
});

test('private method calls retain their named gate effects', () => {
  expect(
    serializationFindings(
      [],
      [
        {
          file: 'probe.ts',
          text: `class Locks {
      #pin(db) { db.query('SELECT id FROM probe.scope_gate WHERE id=1 FOR SHARE'); }
      change(db) { this.#pin(db); db.query('UPDATE probe.scope_gate SET revision=2 WHERE id=1'); }
    }`,
        },
      ],
      [],
    ).map((finding) => [finding.rule, finding.target]),
  ).toEqual([['gate-lock-upgrade', 'probe.scope_gate']]);
});

test('default callback writes remain reachable from a caller shared lock', () => {
  expect(
    serializationFindings(
      [],
      [
        {
          file: 'probe.ts',
          text: `function write(db) { db.query('UPDATE probe.scope_gate SET revision=2 WHERE id=1'); }
      function wrap(run=write) { run(); }
      function change(db) { db.query('SELECT id FROM probe.scope_gate WHERE id=1 FOR SHARE'); wrap(); }`,
        },
      ],
      [],
    ).map((finding) => [finding.rule, finding.target]),
  ).toEqual([['gate-lock-upgrade', 'probe.scope_gate']]);
});

test('lexical callback aliases remain reachable beside same-name function initializers', () => {
  expect(
    serializationFindings(
      [],
      [
        {
          file: 'probe.ts',
          text: `const pinCallback=()=>nothing(), writeCallback=()=>nothing();
      function pin(db) { db.query('SELECT id FROM probe.scope_gate WHERE id=1 FOR SHARE'); }
      function write(db) { db.query('UPDATE probe.scope_gate SET revision=2 WHERE id=1'); }
      function wrap(run) { run(); }
      function change() { const pinCallback=pin, writeCallback=write; wrap(pinCallback); wrap(writeCallback); }`,
        },
      ],
      [],
    ).map((finding) => [finding.rule, finding.target]),
  ).toEqual([['gate-lock-upgrade', 'probe.scope_gate']]);
});

test('object methods and accessors preserve TypeScript function names', () => {
  const nodes = indexedSourceNodes({
    file: 'object.ts',
    text: 'const control={ read() {}, get value() { return 1; }, set value(next: number) {}, arrow:()=>1, callback:function(){} };',
  }).filter(ts.isFunctionLike);
  expect(nodes.map((node) => node.kind)).toEqual([
    ts.SyntaxKind.MethodDeclaration,
    ts.SyntaxKind.GetAccessor,
    ts.SyntaxKind.SetAccessor,
    ts.SyntaxKind.ArrowFunction,
    ts.SyntaxKind.FunctionExpression,
  ]);
  expect(
    nodes.map((node) => ('name' in node && node.name ? node.name.getText() : undefined)),
  ).toEqual(['read', 'value', 'value', undefined, undefined]);
});

test('object method gate findings retain the method name', () => {
  const findings = serializationFindings(
    [],
    [
      {
        file: 'probe.ts',
        text: `const control={ change(db) {
      db.query('SELECT id FROM probe.scope_gate WHERE id=1 FOR SHARE');
      db.query('UPDATE probe.scope_gate SET revision=2 WHERE id=1');
    }};`,
      },
    ],
    [],
  );
  expect(findings).toHaveLength(1);
  expect(findings[0].detail).toContain(' via probe.ts#change;');
});

test('escaped schema alternatives retain template references', () => {
  expect(
    sourceRelations(
      {
        file: 'probe.ts',
        text: "const hint='access'; db.query(`SELECT * FROM ${'\\u0061ccess'}.missing`)",
      },
      schemas,
    ),
  ).toEqual([{ file: 'probe.ts', line: 1, relation: 'access.missing' }]);
});

test('SQL contained entirely in interpolation preserves template and leaf references', () => {
  expect(
    sourceRelations(
      {
        file: 'probe.ts',
        text: "db.query(`${active ? 'SELECT * FROM access.missing' : ''}`)",
      },
      schemas,
    ),
  ).toEqual([
    { file: 'probe.ts', line: 1, relation: 'access.missing' },
    { file: 'probe.ts', line: 1, relation: 'access.missing' },
  ]);
});

test('cast type SQL literals inside interpolation retain source references', () => {
  expect(
    sourceRelations(
      {
        file: 'probe.ts',
        text: "db.query(`value=${key as 'SELECT * FROM access.missing'}`)",
      },
      schemas,
    ),
  ).toEqual([{ file: 'probe.ts', line: 1, relation: 'access.missing' }]);
});

test('SQL comments between a schema and relation do not hide references', () => {
  expect(
    sourceRelations(
      {
        file: 'probe.ts',
        text: "db.query('SELECT * FROM access/* schema note */.missing')",
      },
      schemas,
    ),
  ).toEqual([{ file: 'probe.ts', line: 1, relation: 'access.missing' }]);
});

test('standalone SQL templates resolve lexical values beside logging templates', () => {
  expect(
    serializationFindings(
      [],
      [
        {
          file: 'probe.ts',
          text: "const sql='SELECT pg_advisory_lock(12)';\nconst indirect=`${sql}`;\nconst message=`failed: ${error.message}`;",
        },
      ],
      [],
    ).map((finding) => [finding.line, finding.target]),
  ).toEqual([
    [1, '12'],
    [2, '12'],
  ]);
});

test('standalone interpolated SQL retains verbs assembled from lexical constants', () => {
  expect(
    serializationFindings(
      [
        {
          file: '001.sql',
          text: 'CREATE TABLE probe.singleton(id boolean PRIMARY KEY CHECK(id));',
        },
      ],
      [
        {
          file: 'probe.ts',
          text: "const verb='UP'+'DATE'; const table='probe.singleton'; const sql=`${verb} ${table} SET id=true`;",
        },
      ],
      [],
    ).map((finding) => [finding.rule, finding.target]),
  ).toEqual([
    ['singleton-table', 'probe.singleton'],
    ['singleton-write', 'probe.singleton'],
  ]);
});

test('serialization keeps interpolated templates as one SQL value', () => {
  expect(
    serializationFindings(
      [],
      [
        {
          file: 'probe.ts',
          text: "db.query(`${db.query('SELECT pg_advisory_lock(12)')}`)",
        },
      ],
      [],
    ),
  ).toEqual([]);
  expect(
    serializationFindings(
      [],
      [
        {
          file: 'probe.ts',
          text: "const sql=`${['SELECT pg_advisory_lock(12)'].join('')}`;",
        },
      ],
      [],
    ),
  ).toEqual([]);
});

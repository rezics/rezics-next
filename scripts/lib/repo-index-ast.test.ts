// sql-relations-allow: access.live -- Synthetic indexed SQL fixture names an example relation.
// sql-relations-allow: access.missing -- Synthetic indexed SQL fixture names a missing relation.
import { expect, test } from 'bun:test';
import ts from 'typescript-6';
import { indexedOffsets, indexedSourceNodes } from './repo-index-ast.ts';
import { relationExemptions, sourceRelations, sourceSqlLiterals } from '../qa/sql-relations.ts';
import { serializationFindings } from '../qa/serialization-points.ts';

const schemas = new Set(['access']);

test('indexed syntax handles Unicode and interpolation trivia', () => {
  const text = 'const label = "阅读";\n' +
    'db.query(`SELECT * FROM access.live\n WHERE id = ${ value /* } */ }\n' +
    'AND EXISTS(SELECT 1 FROM access.missing)`);';
  expect(sourceRelations({ file: 'probe.ts', text }, schemas)).toEqual([
    { file: 'probe.ts', line: 2, relation: 'access.live' },
    { file: 'probe.ts', line: 4, relation: 'access.missing' },
  ]);
});

test('indexed lexical comments preserve exemptions and ignore literals', () => {
  const text = "const x = 'sql-relations-allow: access.fake -- string';\n" +
    '// sql-relations-allow: access.live -- Deliberate probe.\nconst y=1;';
  expect([...relationExemptions({ file: 'probe.test.ts', text })]).toEqual([
    ['access.live', 'Deliberate probe.'],
  ]);
});

test('indexed extraction does not emit SQL chunks from interpolated templates', () => {
  expect(sourceSqlLiterals({
    file: 'probe.ts',
    text: 'const q=`SELECT * FROM access.${table}`;',
  })).toEqual([]);
});

test('interpolation comments cannot hide a following relation on the same line', () => {
  const text = 'db.query(`SELECT * FROM access.live WHERE id=${ /* ${ */ value /* } -- */ } ' +
    'AND EXISTS(SELECT 1 FROM access.missing)`);';
  expect(sourceRelations({ file: 'probe.ts', text }, schemas).map(reference => reference.relation))
    .toEqual(['access.live', 'access.missing']);
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
  expect(nodes.map(node => node.kind)).toEqual([
    ts.SyntaxKind.Constructor, ts.SyntaxKind.GetAccessor, ts.SyntaxKind.SetAccessor,
  ]);
  expect('name' in nodes[0]).toBe(false);
  expect(nodes[0].parameters[0].name.getText()).toBe('db');
});


test('interpolated schema alternatives remain visible to relation rules', () => {
  expect(sourceRelations({
    file: 'probe.ts',
    text: "db.query(`SELECT * FROM ${active ? 'access' : 'other'}.missing`)",
  }, schemas)).toEqual([{ file: 'probe.ts', line: 1, relation: 'access.missing' }]);
});


test('SQL literals in type declarations retain relation rules and positions', () => {
  expect(sourceRelations({
    file: 'probe.ts',
    text: "type Query =\n  'SELECT * FROM access.missing';",
  }, schemas)).toEqual([{ file: 'probe.ts', line: 2, relation: 'access.missing' }]);
});


test('SQL literals in type declarations retain advisory-key rules', () => {
  expect(serializationFindings([], [{
    file: 'probe.ts',
    text: "type Query = 'SELECT pg_advisory_lock(12)';",
  }], []).map(finding => [finding.rule, finding.target, finding.line]))
    .toEqual([['constant-advisory-key', '12', 1]]);
});

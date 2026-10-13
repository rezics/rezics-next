import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

interface Node {
  file: string;
  text: string;
  kind: string;
  range: { byteOffset: { start: number; end: number }; start: { line: number } };
}
const root = resolve(import.meta.dir, '../../..');
function nodes(files: string[], source?: string): Node[] {
  return ['object', 'pair', 'shorthand_property_identifier', 'call_expression', 'function_declaration'].flatMap(kind => {
    const result = execFileSync('task', ['ast-grep', '--', 'run', '--lang', 'typescript', '--json=compact',
      ...(kind === 'call_expression' ? ['--pattern', '$NS.Object($$$)'] : ['--kind', kind]),
      ...(source === undefined ? files : ['--stdin'])], {
      cwd: root, encoding: 'utf8', input: source, maxBuffer: 64 * 1024 * 1024, timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return (JSON.parse(result) as Node[]).map(node => ({ ...node, kind }));
  });
}
const contains = (outer: Node, inner: Node) => outer.file === inner.file
  && outer.range.byteOffset.start <= inner.range.byteOffset.start
  && outer.range.byteOffset.end >= inner.range.byteOffset.end;

function violations(all: Node[], alias?: string): string[] {
  const objects = all.filter(node => node.kind === 'object');
  const properties = new Map<Node, Map<string, string>>(objects.map(node => [node, new Map()]));
  for (const pair of all.filter(node => node.kind === 'pair' || node.kind === 'shorthand_property_identifier')) {
    const owner = objects.filter(object => contains(object, pair)).sort((a, b) =>
      (a.range.byteOffset.end - a.range.byteOffset.start) - (b.range.byteOffset.end - b.range.byteOffset.start))[0];
    if (!owner) continue;
    const match = pair.text.match(/^(?:['"]([^'"]+)['"]|([\w$-]+))\s*:\s*([\s\S]*)$/);
    if (match) properties.get(owner)!.set(match[1] ?? match[2]!, match[3]!);
    else if (pair.kind === 'shorthand_property_identifier') properties.get(owner)!.set(pair.text, pair.text);
  }
  const schemas = all.filter(node => node.kind === 'call_expression' && /^(?:t|Type)\.Object\s*\(/.test(node.text));
  const canonical = all.filter(node => node.kind === 'function_declaration'
    && basename(alias ?? node.file) === 'problems.ts' && /^export\s+function\s+problem\s*\(|^function\s+problem\s*\(/.test(node.text));
  return [...new Set(objects.flatMap(object => {
    if (schemas.some(schema => contains(schema, object)) || canonical.some(owner => contains(owner, object))) return [];
    const members = properties.get(object)!;
    const type = members.get('type') ?? '';
    const status = members.get('status');
    const possibleRefusal = status !== undefined && (/^\d+$/.test(status) ? Number(status) >= 400
      : !/^['"`]|^(?:true|false|null)$/.test(status));
    if (members.get('content-type')?.includes('application/problem+json') || type.includes('rezics.com/problems/')
      || possibleRefusal && ['type', 'title', 'status', 'code'].every(name => members.has(name))) {
      return [`${basename(alias ?? object.file)}:${object.range.start.line + 1}`];
    }
    return [];
  }))];
}

/** Check producers, including values handed to Response.json through a variable.
 * Schema declarations are calls, whereas a problem value has literal members. */
const inlineProblems = (source: string, file = 'route.ts') => violations(nodes([], source), file);

test('Main routes use the canonical problem owner for every problem answer', () => {
  const directory = join(import.meta.dir, '../src/routes');
  const files = readdirSync(directory).filter(file => file.endsWith('.ts')).map(file => join(directory, file));
  expect(violations(nodes(files))).toEqual([]);
});

test('guard rejects restored inline problems, variables, MIME-only and spread forms', () => {
  for (const source of [
    `return Response.json({type: 'https://rezics.com/problems/stale_head', title: 'Stale', status: 409,
      code: 'stale_head', currentHead: null}, {status: 409});`,
    `const body = {type: uri, title, status, code}; return Response.json(body, {status});`,
    `return new Response(JSON.stringify(body), {headers: {'content-type': 'application/problem+json'}});`,
    `return Response.json({...{type: 'about:blank', title, status: 409, code}, current});`,
    `return Response.json({type: problemType(), title: titleFor(code), status: 409, code});`,
  ]) expect(inlineProblems(source).length).toBeGreaterThan(0);
});

test('guard admits successful JSON, declarations and only the canonical implementation', () => {
  expect(inlineProblems(`return Response.json({currentHead: null, replayed: false}, {status: 201});`)).toEqual([]);
  expect(inlineProblems(`return Response.json({type: 'asset', title: 'Cover', status: 200, code: 'ready'});`)).toEqual([]);
  expect(inlineProblems(`const schema = t.Object({type: t.Literal('https://rezics.com/problems/stale_head'),
    title: t.String(), status: t.Literal(409), code: t.String()});`)).toEqual([]);
  const source = readFileSync(join(import.meta.dir, '../src/routes/problems.ts'), 'utf8');
  expect(inlineProblems(source, 'problems.ts')).toEqual([]);
  expect(inlineProblems(source, 'other.ts').length).toBeGreaterThan(0);
});

import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/u, '');

function repoPath(path: string): string {
  const prefix = `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
const scanRoots = ['tests/qa/integration', 'tests/qa/fault-recovery', 'services/main/tests'];
const groupId = /^[a-z][a-z0-9-]{0,63}$/;

/** Callers that name a closed path without sending it to Main. */
const allowlist: Record<string, string> = {
  'services/main/tests/g-543-rate-limit.test.ts':
    'Closed paths are rate-limit policy keys, or fetches to a local stub, not Main.',
  'services/main/tests/g-970-rate-limit.test.ts':
    'The platform-admin path is a rate-limit family key, not a request to Main.',
};

interface ClosedOperation {
  method: string;
  path: string;
  group: string;
}

interface Caller {
  file: string;
  groups: string[];
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

function normalizeLiteral(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '$' && raw[i + 1] === '{') {
      let depth = 1;
      i += 2;
      for (; i < raw.length && depth; i++) {
        if (raw[i] === '{') depth++;
        else if (raw[i] === '}') depth--;
      }
      i--;
      out += '{param}';
      continue;
    }
    if (raw[i] === '?' || raw[i] === '#') break;
    out += raw[i];
  }
  if (out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

function segments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function pathMatch(literal: string, template: string): boolean {
  const got = segments(literal);
  const want = segments(template);
  if (got.length !== want.length || got.length === 0) return false;
  if (got[0] !== 'v1' && got[0] !== 'v2') return false;
  for (let i = 0; i < got.length; i++) {
    const left = got[i]!;
    const right = want[i]!;
    if (left === '{param}') {
      if (!right.startsWith('{')) return false;
      continue;
    }
    if (right.startsWith('{')) return false;
    if (left !== right) return false;
  }
  return true;
}

function methodsNear(source: string, index: number, raw: string): string[] {
  const before = source.slice(Math.max(0, index - 90), index);
  if (/rateLimitFamily\s*\(\s*$/.test(before) || /rateLimitFamily\s*\(\s*['"][A-Z]+['"]\s*,\s*$/.test(before)) {
    return [];
  }
  const after = source.slice(index, Math.min(source.length, index + raw.length + 180));
  const quoted = [...before.matchAll(/['"](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"]/g)].map(match => match[1]!);
  const later = [...after.matchAll(/method\s*:\s*['"](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"]/g)]
    .map(match => match[1]!);
  const verb = before.match(/\.(get|post|put|patch|delete)\(\s*$/i);
  const found = new Set([...quoted, ...later]);
  if (verb) found.add(verb[1]!.toUpperCase());
  if (found.size === 0 && /(?:new URL|fetch)\(\s*$/.test(before)) found.add('GET');
  return [...found];
}

export function closedOperations(spec: {
  paths: Record<string, Record<string, { 'x-rezics-exposure'?: string }>>;
}): ClosedOperation[] {
  const ops: ClosedOperation[] = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) continue;
      const exposure = operation['x-rezics-exposure'];
      if (!exposure || exposure === 'public' || !exposure.startsWith('platform:')) continue;
      ops.push({ method: method.toUpperCase(), path, group: exposure.slice('platform:'.length) });
    }
  }
  return ops;
}

export function calledGroups(source: string, ops: readonly ClosedOperation[]): string[] {
  const groups = new Set<string>();
  const literalRe = /(['"`])(\/(?:v1|v2)\/[^'"`\n]*?)\1/g;
  let match: RegExpExecArray | null;
  while ((match = literalRe.exec(source))) {
    const raw = match[2]!;
    const normalized = normalizeLiteral(raw);
    if (!/^\/v[12]\//.test(normalized)) continue;
    const nearby = methodsNear(source, match.index, raw);
    if (nearby.length === 0) continue;
    for (const op of ops) {
      if (!pathMatch(normalized, op.path) || !nearby.includes(op.method)) continue;
      groups.add(op.group);
    }
  }
  return [...groups].sort();
}

function callArguments(source: string, openParen: number): string {
  let depth = 1;
  let index = openParen + 1;
  const end = Math.min(source.length, openParen + 800);
  for (; index < end && depth; index++) {
    if (source[index] === '(') depth++;
    else if (source[index] === ')') depth--;
  }
  return source.slice(openParen + 1, depth === 0 ? index - 1 : index);
}

/** Groups named as literals on grantRecordedPlatformUse or grantPlatformUse. */
export function grantedGroups(source: string): Set<string> {
  const groups = new Set<string>();
  const callRe = /\b(?:grantRecordedPlatformUse|grantPlatformUse)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(source))) {
    const args = callArguments(source, match.index + match[0].length - 1);
    const array = args.match(/\[([\s\S]*?)\]/);
    const region = array?.[1] ?? args;
    for (const quoted of region.matchAll(/['"]([a-z][a-z0-9-]{0,63})['"]/g)) {
      if (groupId.test(quoted[1]!)) groups.add(quoted[1]!);
    }
  }
  return groups;
}

function localImports(source: string): string[] {
  return [...source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map(match => match[1]!);
}

function resolveImport(from: string, spec: string, files: ReadonlySet<string>): string | null {
  if (!spec.startsWith('.')) return null;
  const base = normalize(join(dirname(from), spec)).replaceAll('\\', '/');
  const candidates = spec.endsWith('.ts') ? [base] : [base, `${base}.ts`, `${base}/index.ts`];
  for (const candidate of candidates) {
    if (candidate.startsWith('..')) return null;
    if (!candidate.startsWith('tests/qa/') && !candidate.startsWith('services/main/tests/')) continue;
    if (files.has(candidate) || existsSync(join(root, candidate))) return candidate;
  }
  return null;
}

function readSource(file: string, extra: ReadonlyMap<string, string>): string {
  return extra.get(file) ?? readFileSync(join(root, file), 'utf8');
}

function closureGroups(file: string, files: ReadonlySet<string>, extra: ReadonlyMap<string, string>,
  direct: Map<string, Set<string>>, seen = new Set<string>(), depth = 6): Set<string> {
  if (seen.has(file) || depth < 0) return new Set();
  seen.add(file);
  let own = direct.get(file);
  if (!own) {
    own = grantedGroups(readSource(file, extra));
    direct.set(file, own);
  }
  const groups = new Set(own);
  if (depth === 0) return groups;
  for (const spec of localImports(readSource(file, extra))) {
    const next = resolveImport(file, spec, files);
    if (!next) continue;
    for (const group of closureGroups(next, files, extra, direct, seen, depth - 1)) groups.add(group);
  }
  return groups;
}

export function auditClosedOperationCallers(extra = new Map<string, string>()): string[] {
  for (const [file, reason] of Object.entries(allowlist)) {
    if (!reason.trim()) return [`allowlist entry ${file} has no reason`];
  }
  const spec = JSON.parse(readFileSync(join(root, 'generated/openapi/main/public.json'), 'utf8')) as {
    paths: Record<string, Record<string, { 'x-rezics-exposure'?: string }>>;
  };
  const ops = closedOperations(spec);
  const onDisk = scanRoots.flatMap(dir => walk(join(root, dir)).map(repoPath));
  const files = [...new Set([...onDisk, ...extra.keys()])];
  const known = new Set(files);
  const direct = new Map<string, Set<string>>();
  const callers: Caller[] = [];
  for (const file of files) {
    const source = readSource(file, extra);
    const groups = calledGroups(source, ops);
    if (groups.length === 0) continue;
    callers.push({ file, groups });
  }
  const callerFiles = new Set(callers.map(caller => caller.file));
  const violations: string[] = [];
  for (const file of Object.keys(allowlist)) {
    if (!callerFiles.has(file)) violations.push(`allowlist entry ${file} calls no closed operation`);
  }
  for (const caller of callers) {
    if (allowlist[caller.file]) continue;
    const source = readSource(caller.file, extra);
    const granted = /createMainApp\s*\(/.test(source)
      ? grantedGroups(source)
      : closureGroups(caller.file, known, extra, direct);
    const missing = caller.groups.filter(group => !granted.has(group));
    if (missing.length === 0) continue;
    violations.push(`${caller.file} calls ${missing.join(', ')} without the platform grant helper`);
  }
  return violations.sort();
}

const principal = '00000000-0000-4000-8000-0000000000aa';

test('a closed-operation caller records the group it calls', () => {
  const spec = JSON.parse(readFileSync(join(root, 'generated/openapi/main/public.json'), 'utf8')) as {
    paths: Record<string, Record<string, { 'x-rezics-exposure'?: string }>>;
  };
  const ops = closedOperations(spec);
  const planted = `test('poll', async () => { await call('POST', '/v1/polls', { profile: 'poll' }); });`;
  expect(calledGroups(planted, ops)).toEqual(['institutional-voting']);
  const extra = new Map([['tests/qa/integration/planted-closed-caller.test.ts', planted]]);
  expect(auditClosedOperationCallers(extra).some(gap => gap.includes('planted-closed-caller'))).toBe(true);

  const opened = `test('poll', async () => {
    await grantRecordedPlatformUse(pool, '${principal}', ['institutional-voting']);
    await call('POST', '/v1/polls', { profile: 'poll' });
  });`;
  expect(auditClosedOperationCallers(new Map([['tests/qa/integration/planted-closed-caller.test.ts', opened]]))
    .filter(gap => gap.includes('planted'))).toEqual([]);

  const imported = 'tests/qa/integration/planted-grant-helper.ts';
  const viaImport = `import { openPolls } from './planted-grant-helper.ts';
    test('poll', async () => { await openPolls(); await call('POST', '/v1/polls', {}); });`;
  const helper = `export async function openPolls() {
    await grantRecordedPlatformUse(pool, '${principal}', ['institutional-voting']);
  }`;
  const covered = new Map([
    ['tests/qa/integration/planted-closed-caller.test.ts', viaImport],
    [imported, helper],
  ]);
  expect(auditClosedOperationCallers(covered).filter(gap => gap.includes('planted'))).toEqual([]);
  const ownApp = viaImport.replace('test(', 'const app = createMainApp(fuseki, deps);\ntest(');
  expect(auditClosedOperationCallers(new Map([...covered, ['tests/qa/integration/planted-closed-caller.test.ts', ownApp]]))
    .some(gap => gap.includes('planted-closed-caller') && gap.includes('institutional-voting'))).toBe(true);
});

test('recorded platform use rejects a group and a principal before querying', async () => {
  const db = { query: () => Promise.reject(new Error('queried')) };
  await expect(grantRecordedPlatformUse(db, principal, [])).rejects.toThrow('exposure group');
  await expect(grantRecordedPlatformUse(db, principal, ['Saved-Views'])).rejects.toThrow('exposure group');
  await expect(grantRecordedPlatformUse(db, 'not-a-principal', ['saved-views'])).rejects.toThrow('principal id');
  await expect(grantRecordedPlatformUse(db, principal, ['saved-views'], 'not-an-agent'))
    .rejects.toThrow('agent');
});

test('every closed-operation test opens its groups through the grant helper', () => {
  expect(auditClosedOperationCallers()).toEqual([]);
});

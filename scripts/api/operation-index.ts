import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

type OperationDeclaration = {
  exposure: string;
  rateLimitFamily?: string;
  bearer?: boolean | 'optional';
  idempotencyKey?: boolean;
};

type RouteModule = {
  openApiOperations?: Record<string, Record<string, OperationDeclaration>>;
};

export interface IndexedOperation {
  operationId: string;
  method: string;
  path: string;
  exposure: string;
  rateLimitFamily: string;
  bearer: 'required' | 'optional' | 'no';
  idempotencyKey: boolean;
  routeFile: string;
  handlerLine: number;
  testFiles: string[];
}

export interface OperationSearchResult {
  matches: IndexedOperation[];
  more: number;
  nearestOperationIds?: string[];
}

const maxMatches = 15;
const maxTestsPerTier = 10;
const testFileName = /\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/;
const templateInterpolationStart = '\u0001';
const templateInterpolationEnd = '\u0002';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function operationId(method: string, path: string): string {
  return (method === '*' ? 'all' : method.toLowerCase()) + path.split('/').filter(Boolean).map((segment) => {
    if (segment.startsWith(':')) return `By${segment[1]!.toUpperCase()}${segment.slice(2)}`;
    if (segment.startsWith('{')) return `By${segment[1]!.toUpperCase()}${segment.slice(2, -1)}`;
    return segment[0]!.toUpperCase() + segment.slice(1);
  }).join('');
}

function operationKey(method: string, path: string): string {
  const shape = path.replace(/\{[^}]+\}/g, '{}').replace(/:([A-Za-z0-9_]+)/g, '{}');
  return `${method.toUpperCase()} ${shape}`;
}

function mainSourceFiles(root: string): { file: string; source: string }[] {
  return [...new Bun.Glob('services/main/src/**/*.ts').scanSync({ cwd: root })]
    .filter((file) => file.endsWith('.ts'))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(root, file), 'utf8') }));
}

function routeHandlerLocations(sources: readonly { file: string; source: string }[]): Map<string, { file: string; line: number }> {
  const locations = new Map<string, { file: string; line: number }>();
  const directRoute = /\.(get|post|put|patch|delete|options|head|all|ws)\s*\(\s*(?:(['"])([^'"]+)\2|`((?:\\.|[^`])*)`|([A-Za-z_$][\w$]*))/g;
  const routeMethod = /\.route\s*\(\s*(['"])([A-Z]+)\1\s*,\s*(['"])([^'"]+)\3/g;
  for (const { file, source } of sources) {
    const constants = new Map([...source.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])([^'"]+)\2/g)]
      .map((match) => [match[1]!, match[3]!]));
    const register = (method: string, path: string, position: number) => {
      const key = operationKey(method, path);
      if (!locations.has(key)) {
        locations.set(key, { file, line: source.slice(0, position).split('\n').length });
      }
    };
    for (const match of source.matchAll(directRoute)) {
      const path = match[3]
        ?? match[4]?.replace(/\$\{([^}]+)\}/g, (_expression, name: string) => constants.get(name.trim()) ?? ':operationIndexDynamic')
        ?? constants.get(match[5]!);
      if (path) register(match[1]!, path, match.index!);
    }
    for (const match of source.matchAll(routeMethod)) register(match[2]!, match[4]!, match.index!);
  }
  return locations;
}

function skipQuoted(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') index += 2;
    else if (source[index] === quote) return index + 1;
    else index++;
  }
  return source.length;
}

function readQuoted(source: string, start: number, quote: string): { pattern: string; end: number } {
  const end = skipQuoted(source, start, quote);
  let pattern = '';
  for (let index = start + 1; index < end - 1; index++) {
    if (source[index] === '\\' && index + 1 < end - 1) pattern += source[++index];
    else pattern += source[index];
  }
  return { pattern, end };
}

function skipLineComment(source: string, start: number): number {
  const newline = source.indexOf('\n', start + 2);
  return newline < 0 ? source.length : newline + 1;
}

function skipBlockComment(source: string, start: number): number {
  const close = source.indexOf('*/', start + 2);
  return close < 0 ? source.length : close + 2;
}

function skipTemplateExpression(source: string, start: number): number {
  let depth = 1;
  let index = start;
  while (index < source.length && depth > 0) {
    const current = source[index]!;
    const next = source[index + 1];
    if (current === '"' || current === "'") index = skipQuoted(source, index, current);
    else if (current === '`') index = readTemplate(source, index).end;
    else if (current === '/' && next === '/') index = skipLineComment(source, index);
    else if (current === '/' && next === '*') index = skipBlockComment(source, index);
    else if (current === '{') { depth++; index++; }
    else if (current === '}') { depth--; index++; }
    else index++;
  }
  return index;
}

function readTemplate(source: string, start: number): { pattern: string; end: number } {
  let pattern = '';
  let index = start + 1;
  while (index < source.length) {
    const current = source[index]!;
    if (current === '`') return { pattern, end: index + 1 };
    if (current === '\\') {
      const escaped = source[index + 1];
      if (escaped !== undefined) pattern += escaped;
      index += 2;
    } else if (current === '$' && source[index + 1] === '{') {
      const end = skipTemplateExpression(source, index + 2);
      const expression = source.slice(index + 2, end - 1).trim();
      const name = /^[A-Za-z_$][\w$]*$/.test(expression) ? expression : '';
      pattern += `${templateInterpolationStart}${name}${templateInterpolationEnd}`;
      index = end;
    } else {
      pattern += current;
      index++;
    }
  }
  return { pattern, end: source.length };
}

/** Extracts JS string and template contents while skipping comments. */
export function sourcePathPatterns(source: string): string[] {
  const patterns: string[] = [];
  const constants = new Map<string, string>();
  let index = 0;
  while (index < source.length) {
    const current = source[index]!;
    const next = source[index + 1];
    if ((current === 'c' || current === 'l')
      && (index === 0 || !/[A-Za-z0-9_$]/.test(source[index - 1]!))) {
      const declaration = /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*/.exec(source.slice(index));
      if (declaration) {
        const start = index + declaration[0].length;
        const quote = source[start];
        if (quote === '"' || quote === "'") {
          const literal = readQuoted(source, start, quote);
          patterns.push(literal.pattern);
          constants.set(declaration[1]!, literal.pattern);
          index = literal.end;
          continue;
        }
        if (quote === '`') {
          const literal = readTemplate(source, start);
          patterns.push(literal.pattern);
          constants.set(declaration[1]!, literal.pattern);
          index = literal.end;
          continue;
        }
      }
    }
    if (current === '"' || current === "'") {
      const literal = readQuoted(source, index, current);
      patterns.push(literal.pattern);
      index = literal.end;
    } else if (current === '`') {
      const template = readTemplate(source, index);
      patterns.push(template.pattern);
      index = template.end;
    } else if (current === '/' && next === '/') index = skipLineComment(source, index);
    else if (current === '/' && next === '*') index = skipBlockComment(source, index);
    else index++;
  }
  const interpolation = `${templateInterpolationStart}([A-Za-z_$][\\w$]*)?${templateInterpolationEnd}`;
  const expand = (pattern: string, chain: readonly string[] = []): string => pattern.replace(new RegExp(interpolation, 'g'),
    (_marker, name: string | undefined) => {
      const value = name ? constants.get(name) : undefined;
      return value && !chain.includes(name!) && chain.length < 8
        ? expand(value, [...chain, name!])
        : 'operation-index-segment';
    });
  return patterns.map((pattern) => expand(pattern));
}

function routePathPattern(path: string): string {
  return path.split('/').map((segment) => {
    if (/^\{[^}]+\}$/.test(segment) || /^:[A-Za-z0-9_]+$/.test(segment)) return '[^/?#]+';
    return escapeRegExp(segment);
  }).join('/');
}

function pathMatcher(path: string): RegExp {
  return new RegExp(`(?:^|[^A-Za-z0-9_])${routePathPattern(path)}(?=$|[?#])`);
}

export function sourceCallsPath(source: string, path: string): boolean {
  const matcher = pathMatcher(path);
  return sourcePathPatterns(source).some((pattern) => matcher.test(pattern));
}

function testTierDirectory(path: string): string {
  const parts = path.split('/');
  if (parts[0] !== 'tests') return parts.slice(0, -1).join('/');
  if (parts[1] === 'qa') {
    if (parts[2] === 'integration' && parts[3] === 'outcomes') return parts.slice(0, 4).join('/');
    return parts.slice(0, 3).join('/');
  }
  return parts.slice(0, 2).join('/');
}

export function groupTestFiles(files: readonly string[]) {
  const groups = new Map<string, string[]>();
  for (const file of [...files].sort()) {
    const directory = testTierDirectory(file);
    const group = groups.get(directory) ?? [];
    group.push(file);
    groups.set(directory, group);
  }
  return [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([directory, values]) => ({
    directory,
    files: values.slice(0, maxTestsPerTier),
    more: Math.max(0, values.length - maxTestsPerTier),
  }));
}

function readTestSources(root: string): { path: string; patterns: string[] }[] {
  return [...new Bun.Glob('tests/**/*').scanSync({ cwd: root })]
    .filter((path) => testFileName.test(path))
    .sort()
    .map((path) => ({
      path,
      patterns: sourcePathPatterns(readFileSync(join(root, path), 'utf8')),
    }));
}

function routeFiles(root: string): string[] {
  return readdirSync(join(root, 'services/main/src/routes'))
    .filter((file) => file.endsWith('.ts'))
    .sort();
}

export async function buildOperationIndex(root = resolve(import.meta.dir, '../..')): Promise<IndexedOperation[]> {
  const routeDirectory = join(root, 'services/main/src/routes');
  const sources = mainSourceFiles(root);
  const hasher = createHash('sha256').update(readFileSync(join(import.meta.dir, 'operation-index.ts'), 'utf8'));
  for (const { file, source } of sources) hasher.update(`\0${file}\0${source}`);
  const cacheKey = hasher.digest('hex');
  const cacheFile = join(root, '.temp/api-operation-index.json');
  let routes: IndexedOperation[] | undefined;
  if (existsSync(cacheFile)) {
    try {
      const cache = JSON.parse(readFileSync(cacheFile, 'utf8')) as { key: string; operations: IndexedOperation[] };
      if (cache.key === cacheKey) routes = cache.operations.map((operation) => ({ ...operation, testFiles: [] }));
    } catch { /* Rebuild an incomplete or malformed scratch cache. */ }
  }
  if (!routes) {
    const handlers = routeHandlerLocations(sources);
    routes = [];
    for (const file of routeFiles(root)) {
      const module = await import(join(routeDirectory, file)) as RouteModule;
      const declarations = module.openApiOperations ?? {};
      for (const [path, methods] of Object.entries(declarations)) {
        for (const [method, declaration] of Object.entries(methods)) {
          const handler = handlers.get(operationKey(method, path));
          if (!handler) throw new Error(`Cannot find handler for ${method.toUpperCase()} ${path} in routes/${file}`);
          routes.push({
            operationId: operationId(method, path),
            method: method.toUpperCase(),
            path,
            exposure: declaration.exposure,
            rateLimitFamily: declaration.rateLimitFamily ?? 'unspecified',
            bearer: declaration.exposure !== 'public' || declaration.bearer === true
              ? 'required'
              : declaration.bearer === 'optional' ? 'optional' : 'no',
            idempotencyKey: declaration.idempotencyKey === true,
            routeFile: handler.file,
            handlerLine: handler.line,
            testFiles: [],
          });
        }
      }
    }
    routes.sort((left, right) => left.operationId.localeCompare(right.operationId));
    mkdirSync(join(root, '.temp'), { recursive: true });
    writeFileSync(cacheFile, `${JSON.stringify({ key: cacheKey, operations: routes }, null, 2)}\n`);
  }

  return routes;
}

export function attachCallingTests(operations: IndexedOperation[], root = resolve(import.meta.dir, '../..')): void {
  const tests = readTestSources(root);
  for (const operation of operations) {
    const matches = pathMatcher(operation.path);
    operation.testFiles = tests.filter(({ patterns }) => patterns.some((pattern) => matches.test(pattern)))
      .map(({ path }) => path);
  }
}

function words(value: string): string[] {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function levenshtein(left: string, right: string): number {
  const prior = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    let diagonal = prior[0]!;
    prior[0] = row;
    for (let column = 1; column <= right.length; column++) {
      const above = prior[column]!;
      prior[column] = Math.min(
        prior[column]! + 1,
        prior[column - 1]! + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return prior[right.length]!;
}

function nearestOperationIds(operations: readonly IndexedOperation[], query: string): string[] {
  const queryWords = words(query);
  return operations.map((operation) => {
    const candidates = words(`${operation.operationId} ${operation.method} ${operation.path}`);
    const distance = queryWords.reduce((total, queryWord) => total + Math.min(...candidates.map((candidate) =>
      levenshtein(queryWord, candidate))), 0);
    return { id: operation.operationId, distance };
  }).sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id))
    .slice(0, 3).map(({ id }) => id);
}

export function searchOperations(operations: readonly IndexedOperation[], query: string): OperationSearchResult {
  const trimmed = query.trim();
  const exact = /^([a-z]+)\s+(\/\S+)$/.exec(trimmed);
  const matches = exact
    ? operations.filter((operation) => operation.method === exact[1]!.toUpperCase() && operation.path === exact[2])
    : (() => {
      const queryWords = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
      return operations.filter((operation) => {
        const searchable = `${operation.operationId} ${operation.method} ${operation.path}`.toLowerCase();
        return queryWords.every((word) => searchable.includes(word));
      });
    })();
  if (matches.length === 0) return { matches: [], more: 0, nearestOperationIds: nearestOperationIds(operations, trimmed) };
  return { matches: matches.slice(0, maxMatches), more: Math.max(0, matches.length - maxMatches) };
}

function displayOperation(operation: IndexedOperation) {
  return {
    operationId: operation.operationId,
    method: operation.method,
    path: operation.path,
    exposure: operation.exposure,
    rateLimitFamily: operation.rateLimitFamily,
    bearer: operation.bearer,
    idempotencyKey: operation.idempotencyKey,
    handler: `${operation.routeFile}:${operation.handlerLine}`,
    tests: groupTestFiles(operation.testFiles),
  };
}

export function formatHumanResult(result: OperationSearchResult): string {
  if (result.matches.length === 0) {
    return [
      'No matching API operations.',
      `Nearest operationIds: ${result.nearestOperationIds?.join(', ') ?? 'none'}`,
    ].join('\n');
  }

  const blocks = result.matches.map((operation) => {
    const tests = groupTestFiles(operation.testFiles);
    const testLines = tests.length === 0 ? ['  tests: none'] : [
      '  tests:',
      ...tests.flatMap((group) => [
        `    ${group.directory}:`,
        ...group.files.map((file) => `      ${file}`),
        ...(group.more > 0 ? [`      and ${group.more} more`] : []),
      ]),
    ];
    return [
      `operationId: ${operation.operationId}`,
      `${operation.method} ${operation.path}`,
      `exposure: ${operation.exposure}`,
      `rate-limit family: ${operation.rateLimitFamily}`,
      `bearer: ${operation.bearer}`,
      `idempotency key: ${operation.idempotencyKey ? 'yes' : 'no'}`,
      `handler: ${operation.routeFile}:${operation.handlerLine}`,
      ...testLines,
    ].join('\n');
  });
  if (result.more > 0) blocks.push(`${result.more} more; narrow the query`);
  return blocks.join('\n\n');
}

export async function runOperationIndex(args: string[], root = resolve(import.meta.dir, '../..')): Promise<number> {
  const json = args.includes('--json');
  const query = args.filter((arg) => arg !== '--json').join(' ').trim();
  if (!query) {
    process.stderr.write('Usage: task operation -- <query> [--json]\n');
    return 2;
  }
  const operations = await buildOperationIndex(root);
  const result = searchOperations(operations, query);
  if (result.matches.length > 0) attachCallingTests(result.matches, root);
  if (json) {
    const output = result.matches.length === 0
      ? { matches: [], more: 0, nearestOperationIds: result.nearestOperationIds }
      : { matches: result.matches.map(displayOperation), more: result.more };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else process.stdout.write(`${formatHumanResult(result)}\n`);
  return result.matches.length === 0 ? 1 : 0;
}

if (import.meta.main) process.exitCode = await runOperationIndex(process.argv.slice(2));

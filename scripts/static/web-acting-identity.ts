import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Schema { properties?: Record<string, Schema>; required?: string[]; anyOf?: Schema[]; oneOf?: Schema[]; allOf?: Schema[] }
interface Operation {
  parameters?: { in: string; name: string; required?: boolean }[];
  requestBody?: { content?: Record<string, { schema?: Schema }> };
}
export interface ReadContract { paths: Record<string, { get?: Operation; post?: Operation }> }
const schemaActor = (schema: Schema): boolean => Boolean(schema.properties?.actingSubject)
  || Object.values(schema.properties ?? {}).some(schemaActor)
  || [...schema.anyOf ?? [], ...schema.oneOf ?? [], ...schema.allOf ?? []].some(schemaActor);
const requiredActor = (schema: Schema): boolean => Boolean(schema.required?.includes('actingSubject'))
  || Object.values(schema.properties ?? {}).some(requiredActor)
  || [...schema.anyOf ?? [], ...schema.oneOf ?? [], ...schema.allOf ?? []].some(requiredActor);
export interface ActingReadViolation { path: string; operation: string; read: string; input: string }
export interface ActingReadDebt extends ActingReadViolation {
  id: string; reason: string; occurrences?: number; unusedExport?: string;
}

// Compare executable tokens, preserving strings while ignoring comments and layout.
// A comment inside a call is as harmless as one elsewhere in its file.
const tokenPattern = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*[^]*?\*\/|\/\/[^\n]*|[A-Za-z_$][\w$]*|\S/g;
const isComment = (token: string) => token.startsWith('/*') || token.startsWith('//');
const tokens = (source: string) => (source.match(tokenPattern) ?? []).filter(token => !isComment(token));
const withoutComments = (source: string) => source.replace(tokenPattern, token => isComment(token) ? ' ' : token);
const code = (source: string) => tokens(source).join('');
function inlineActorType(parameter: string): boolean {
  const type = tokens(parameter.slice(parameter.indexOf(':') + 1));
  if (type[0] !== '{') return false;
  let depth = 0;
  return type.some((token, index) => {
    if (token === '{') depth++;
    if (token === '}') depth--;
    return depth === 1 && token === 'actingSubject' && (type[index + 1] === ':'
      || type[index + 1] === '?' && type[index + 2] === ':');
  });
}

/** Exact, named gaps in the analyzer, not approvals of files or dependencies.
 * Correctly transported reads never need inventory changes. A changed input,
 * operation or additional occurrence cannot inherit an existing debt entry.
 */
export function unresolvedActingReads(root: string, violations: ActingReadViolation[], debt: ActingReadDebt[], files: string[] = []) {
  const remaining = debt.map(item => item.occurrences ?? 1);
  return violations.filter(item => {
    const index = debt.findIndex((entry, index) => remaining[index]! > 0 && entry.id && entry.reason
      && entry.path === item.path && entry.operation === item.operation
      && code(entry.read) === code(item.read) && code(entry.input) === code(item.input)
      // Dormant code remains debt only while it has no production caller.
      && !(entry.unusedExport && (!files.length || files.some(path => path !== item.path
        && new RegExp(`\\b${entry.unusedExport}\\b`).test(readFileSync(resolve(root, path), 'utf8'))))));
    if (index < 0) return true;
    remaining[index]!--;
    return false;
  });
}
interface Capture { text: string }
interface Match {
  file: string; text: string;
  range: { byteOffset: { start: number; end: number } };
  metaVariables?: { single: Record<string, Capture>; multi: Record<string, Capture[]> };
}

// Use the repository's pinned parser, so comments, strings and TSX are not calls.
function matches(root: string, files: string[], pattern: string, kind = false): Match[] {
  if (!files.length) return [];
  const result = Bun.spawnSync({ cwd: root, cmd: [resolve(root, 'node_modules/.bin/ast-grep'),
    'run', kind ? '--kind' : '--pattern', pattern, '--json=compact', ...files], stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error(Buffer.from(result.stderr).toString());
  return (JSON.parse(Buffer.from(result.stdout).toString() || '[]') as Match[])
    .map(item => ({ ...item, text: withoutComments(item.text) }));
}

// Strip balanced call arguments, retaining the Eden member path.
function edenPath(client: string): string | null {
  client = code(client);
  const start = client.search(/\.v\d+\b/);
  if (start < 0) return null;
  let value = client.slice(start);
  for (;;) {
    const at = value.indexOf('(');
    if (at < 0) break;
    let depth = 1, end = at + 1;
    for (; end < value.length && depth; end++) {
      if (value[end] === '(') depth++;
      if (value[end] === ')') depth--;
    }
    value = `${value.slice(0, at)}.{parameter}${value.slice(end)}`;
  }
  return value.replace(/\[\s*['"]([^'"]+)['"]\s*\]/g, '.$1').replace(/\s/g, '').replaceAll('?.', '.')
    .replaceAll('.', '/');
}
const canonical = (path: string) => path.replace(/\{[^}]+\}/g, '{parameter}');
const hasActor = (text: string) => /(?:[,{])\s*actingSubject\s*(?:[:,}])/.test(
  text.replace(/\/\*[^]*?\*\/|\/\/[^\n]*|(['"])(?:\\.|(?!\1)[^\\])*?\1/g, "''"),
) && !/\bactingSubject\s*:\s*(?:undefined|null)\b/.test(text);

/** Inventory GETs and body-bearing reads (POST without an Idempotency-Key contract)
 * against Main's served schemas. Commands retain their mandatory typed inputs.
 * An explicit anonymous adapter is allowed; an unknown client is never assumed anonymous.
 * This checks identity transport, not which Agent is eligible (the session owner decides that).
 */
export function webActingIdentityViolations(root: string, files: string[], contract: ReadContract): ActingReadViolation[] {
  const routes = Object.entries(contract.paths).flatMap(([path, methods]) => Object.entries(methods)
    .filter(([method, operation]) => method === 'get'
      ? operation.parameters?.some(parameter => parameter.in === 'query' && parameter.name === 'actingSubject')
      : method === 'post' && !operation.parameters?.some(parameter => parameter.name.toLowerCase() === 'idempotency-key')
        && Object.values(operation.requestBody?.content ?? {}).some(content => content.schema && schemaActor(content.schema)))
    .map(([method, operation]) => ({ path, method, operation })));
  const declarations = matches(root, files, 'variable_declarator', true);
  const blocks = matches(root, files, 'statement_block', true);
  const pairs = matches(root, files, 'pair', true);
  const parameters = matches(root, files, 'formal_parameters', true);
  const typedParameters = matches(root, files, 'required_parameter', true);
  const functions = ['function_declaration', 'function_expression', 'arrow_function', 'method_definition']
    .flatMap(kind => matches(root, files, kind, true));
  const calls = matches(root, files, '$CALLEE($$$ARGS)');
  const perFile = new Map(files.map(file => [file, {
    declarations: declarations.filter(item => item.file === file),
    blocks: blocks.filter(item => item.file === file),
    pairs: pairs.filter(item => item.file === file),
    parameters: parameters.filter(item => item.file === file),
    typedParameters: typedParameters.filter(item => item.file === file),
    functions: functions.filter(item => item.file === file),
  }]));
  const violations: ActingReadViolation[] = [];
  for (const call of calls) {
    const offset = call.range.byteOffset.start;
    const inventory = perFile.get(call.file)!;
    const scopeOf = (item: Match) => inventory.functions.filter(scope =>
      scope.range.byteOffset.start <= item.range.byteOffset.start && scope.range.byteOffset.end >= item.range.byteOffset.end)
      .sort((a, b) => (a.range.byteOffset.end - a.range.byteOffset.start) - (b.range.byteOffset.end - b.range.byteOffset.start))[0];
    const parameterOf = (name: string) => [...inventory.parameters.filter(parameter =>
      new RegExp(`(?:\\(|,)\\s*${name}\\s*[:,)]`).test(parameter.text)
      && parameter.range.byteOffset.end < offset && (scopeOf(parameter)?.range.byteOffset.end ?? 0) > offset),
      ...inventory.functions.filter(scope => new RegExp(`^(?:async\\s+)?${name}\\s*=>`).test(scope.text)
        && scope.range.byteOffset.start < offset && scope.range.byteOffset.end > offset)]
      .sort((a, b) => b.range.byteOffset.start - a.range.byteOffset.start)[0];
    const local = inventory.declarations.filter(item => item.range.byteOffset.start < offset
      && inventory.blocks.filter(block => block.range.byteOffset.start < item.range.byteOffset.start
        && block.range.byteOffset.end > item.range.byteOffset.end)
        .every(block => block.range.byteOffset.start < offset && block.range.byteOffset.end > offset));
    const expand = (text: string, seen = new Set<string>()): string => {
      text = withoutComments(text);
      const name = text.trim().match(/^[A-Za-z_$][\w$]*/)?.[0];
      if (!name || seen.has(name)) return text;
      const declaration = [...local].reverse().find(item => new RegExp(`^${name}\\s*(?::[^=]+)?=`).test(item.text)
        || (item.text.startsWith('{') && new RegExp(`\\b${name}\\b`).test(item.text.split('=')[0]!)));
      const parameter = parameterOf(name);
      if (parameter && (!declaration || declaration.range.byteOffset.start < parameter.range.byteOffset.end)) return text;
      if (!declaration) return text;
      const value = declaration.text.slice(declaration.text.indexOf('=') + 1).trim();
      const binding = declaration.text.split('=')[0]!;
      // Rest retains identity unless the destructure explicitly removes it.
      if (binding.startsWith('{') && (!new RegExp(`\\.\\.\\.${name}\\b`).test(binding)
        || /\bactingSubject\b/.test(binding))) return text;
      return expand(value, new Set([...seen, name])) + text.trim().slice(name.length);
    };
    const rawCallee = code(call.metaVariables?.single.CALLEE?.text ?? '');
    const callee = /\.(?:get|post)$/.test(rawCallee) ? rawCallee : code(expand(rawCallee));
    const arguments_ = (call.metaVariables?.multi.ARGS ?? []).filter(item => item.text !== ',');
    const args = arguments_.map(item => withoutComments(item.text));
    let path: string | null = null, actor = false, anonymous = false, method = 'get', input = '';
    if (/\.(?:get|post)$/.test(callee)) {
      method = callee.endsWith('.post') ? 'post' : 'get';
      const client = callee.slice(0, -(method.length + 1));
      path = edenPath(client) ?? edenPath(expand(client));
      if (!path) continue;
      const queryPair = inventory.pairs.find(item => /^query\s*:/.test(item.text)
        && item.range.byteOffset.start > offset && item.range.byteOffset.end < call.range.byteOffset.end);
      const query = method === 'post' ? args[0] ?? '' : queryPair?.text.replace(/^query\s*:/, '')
        ?? (/^\{query[,}]/.test(code(args[0] ?? '')) ? 'query' : '');
      const expandedQuery = expand(query);
      input = expandedQuery;
      // A whole parameter typed with an identity field carries that field;
      // reconstructing a query without it does not. Keep unknown aliases as debt.
      const forwardsActor = (name: string) => inventory.typedParameters.some(parameter =>
        new RegExp(`^${name}\\s*:\\s*\\{`).test(parameter.text)
        && inlineActorType(parameter.text)
        && scopeOf(parameter) === scopeOf(parameterOf(name) ?? call)
        && parameterOf(name)?.range.byteOffset.start! <= parameter.range.byteOffset.start
        && parameterOf(name)?.range.byteOffset.end! >= parameter.range.byteOffset.end);
      actor = !/\bactingSubject\s*:\s*(?:undefined|null)\b/.test(code(expandedQuery)) && (hasActor(expandedQuery)
        || /^[A-Za-z_$][\w$]*$/.test(expandedQuery) && forwardsActor(expandedQuery)
        || [...expandedQuery.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)]
          .some(match => hasActor(expand(match[1]!)) || forwardsActor(expand(match[1]!))));
      const expandedClient = expand(client).replace(/^\(\)\s*=>\s*/, '').replace(/\s/g, '');
      anonymous = /^mainApiWithToken\(undefined\)(?:\(\))?\.v\d+\b/.test(expandedClient)
        || /^browserMainApi\([^]*\banonymous:true\b[^]*\)\.v\d+\b/.test(expandedClient);
    } else if (/^(?:(?:globalThis|window)\.)?(?:fetch|fetcher|serverRead|serverFetch)$/.test(callee)) {
      const url = expand(args[0] ?? '');
      const queryText = [...url.matchAll(/\$\{([A-Za-z_$][\w$]*)\}/g)]
        .map(match => expand(match[1]!)).join(' ');
      const options = expand(args[1] ?? '');
      input = `${url} ${options}`;
      method = options.match(/\bmethod:\s*['"]([A-Z]+)['"]/i)?.[1]?.toLowerCase() ?? 'get';
      if (method !== 'get' && method !== 'post') continue;
      path = url.replace(/\$\{[^}]*\}/g, '{parameter}').match(/\/v\d+\/[^`'"?\s),]+/)?.[0] ?? null;
      if (!path) continue;
      const source = readFileSync(resolve(root, call.file), 'utf8');
      const variable = args[0]?.trim();
      actor = /[?&]actingSubject=/.test(url) || /new URLSearchParams\([^]*\bactingSubject\b/.test(url + queryText)
        || Boolean(variable && new RegExp(`${variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.searchParams\\.set\\(['"]actingSubject['"]`)
          .test(Buffer.from(source).subarray(0, offset).toString()));
      if (method === 'post') {
        const body = inventory.pairs.find(item => /^body\s*:/.test(item.text)
          && item.range.byteOffset.start > offset && item.range.byteOffset.end < call.range.byteOffset.end)?.text ?? '';
        actor = hasActor(body) || [...body.matchAll(/JSON\.stringify\(([A-Za-z_$][\w$]*)\)/g)]
          .some(match => hasActor(expand(match[1]!)));
      }
      anonymous = /\bcredentials:\s*['"]omit['"]/.test(options)
        || /^(?:serverRead|serverFetch)$/.test(callee)
          && !/authorization|\btoken\b|\bheaders\b|credentials/.test(options);
    }
    if (!path || actor) continue;
    const route = routes.find(candidate => candidate.method === method && new RegExp(`^${canonical(candidate.path)
      .replaceAll('{parameter}', '[^/]+')}$`).test(path!));
    if (!route) continue;
    const required = route.operation.parameters?.some(parameter => parameter.name === 'actingSubject' && parameter.required)
      || Object.values(route.operation.requestBody?.content ?? {}).some(content => content.schema && requiredActor(content.schema));
    if (anonymous && !required) continue;
    violations.push({ path: call.file, operation: `${method.toUpperCase()} ${route.path}`, read: call.text, input });
  }
  return violations.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

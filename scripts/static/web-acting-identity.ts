import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
export interface ActingReadViolation { path: string; operation: string; read: string }
export interface ActingReadReview {
  sha256: string; reason: string; reads: string[]; dependencies?: Record<string, string>; unusedExport?: string;
}

/** Reviewed forwarding/anonymous adapters are bound to both this exact read and
 * the entire source: changing a query initializer cannot inherit an old review.
 * Omissions requiring an owner fix must never enter this inventory.
 */
export function unreviewedActingReads(root: string, violations: ActingReadViolation[], reviews: Record<string, ActingReadReview>, files: string[] = []) {
  const digest = (path: string) => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
  return violations.filter(item => {
    const review = reviews[item.path];
    return !review || !review.reason || !review.reads.includes(`${item.operation}: ${item.read}`)
      || review.sha256 !== digest(item.path)
      || Object.entries(review.dependencies ?? {}).some(([path, sha256]) => digest(path) !== sha256)
      // A dormant export is not a production read. Any new import or invocation
      // requires this read to carry identity before it can join a live journey.
      || Boolean(review.unusedExport && (!files.length || files.some(path => path !== item.path
        && new RegExp(`\\b${review.unusedExport}\\b`).test(readFileSync(resolve(root, path), 'utf8')))));
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
  return JSON.parse(Buffer.from(result.stdout).toString() || '[]') as Match[];
}

// Strip balanced call arguments, retaining the Eden member path.
function edenPath(client: string): string | null {
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
  const calls = matches(root, files, '$CALLEE($$$ARGS)');
  const perFile = new Map(files.map(file => [file, {
    declarations: declarations.filter(item => item.file === file),
    blocks: blocks.filter(item => item.file === file),
    pairs: pairs.filter(item => item.file === file),
    parameters: parameters.filter(item => item.file === file),
  }]));
  const violations: ActingReadViolation[] = [];
  for (const call of calls) {
    const offset = call.range.byteOffset.start;
    const inventory = perFile.get(call.file)!;
    const local = inventory.declarations.filter(item => item.range.byteOffset.start < offset
      && inventory.blocks.filter(block => block.range.byteOffset.start < item.range.byteOffset.start
        && block.range.byteOffset.end > item.range.byteOffset.end)
        .every(block => block.range.byteOffset.start < offset && block.range.byteOffset.end > offset));
    const expand = (text: string, seen = new Set<string>()): string => {
      const name = text.trim().match(/^[A-Za-z_$][\w$]*/)?.[0];
      if (!name || seen.has(name)) return text;
      if (inventory.parameters.some(parameter => new RegExp(`(?:\\(|,)\\s*${name}\\s*[:,)]`).test(parameter.text)
        && parameter.range.byteOffset.end < offset && inventory.blocks.find(block =>
          block.range.byteOffset.start > parameter.range.byteOffset.end)?.range.byteOffset.end! > offset)) return text;
      const declaration = [...local].reverse().find(item => new RegExp(`^${name}\\s*(?::[^=]+)?=`).test(item.text)
        || (item.text.startsWith('{') && new RegExp(`\\b${name}\\b`).test(item.text.split('=')[0]!)));
      if (!declaration) return text;
      const value = declaration.text.slice(declaration.text.indexOf('=') + 1).trim();
      return expand(value, new Set([...seen, name])) + text.trim().slice(name.length);
    };
    const rawCallee = call.metaVariables?.single.CALLEE?.text ?? '';
    const callee = /\.(?:get|post)$/.test(rawCallee) ? rawCallee : expand(rawCallee);
    const arguments_ = (call.metaVariables?.multi.ARGS ?? []).filter(item => item.text !== ',');
    const args = arguments_.map(item => item.text);
    let path: string | null = null, actor = false, anonymous = false, method = 'get';
    if (/\.(?:get|post)$/.test(callee)) {
      method = callee.endsWith('.post') ? 'post' : 'get';
      const client = callee.slice(0, -(method.length + 1));
      path = edenPath(client) ?? edenPath(expand(client));
      if (!path) continue;
      const queryPair = inventory.pairs.find(item => /^query\s*:/.test(item.text)
        && item.range.byteOffset.start > offset && item.range.byteOffset.end < call.range.byteOffset.end);
      const query = method === 'post' ? args[0] ?? '' : queryPair?.text.replace(/^query\s*:/, '')
        ?? (args[0]?.match(/^\{\s*query\s*[,}]/) ? 'query' : '');
      const expandedQuery = expand(query);
      actor = hasActor(expandedQuery)
        || [...expandedQuery.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)]
          .some(match => hasActor(expand(match[1]!)));
      const expandedClient = expand(client).replace(/^\(\)\s*=>\s*/, '').replace(/\s/g, '');
      anonymous = /^mainApiWithToken\(undefined\)(?:\(\))?\.v\d+\b/.test(expandedClient)
        || /^browserMainApi\([^]*\banonymous:true\b[^]*\)\.v\d+\b/.test(expandedClient);
    } else if (/^(?:(?:globalThis|window)\.)?(?:fetch|fetcher|serverRead|serverFetch)$/.test(callee)) {
      const url = expand(args[0] ?? '');
      const queryText = [...url.matchAll(/\$\{([A-Za-z_$][\w$]*)\}/g)]
        .map(match => expand(match[1]!)).join(' ');
      const options = expand(args[1] ?? '');
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
    violations.push({ path: call.file, operation: `${method.toUpperCase()} ${route.path}`, read: call.text.replace(/\s+/g, ' ') });
  }
  return violations.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

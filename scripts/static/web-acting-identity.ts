import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { indexedFiles, type AstNode } from '../lib/repo-index.ts';

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

interface Inventory {
  declarations: Match[]; blocks: Match[]; pairs: Match[];
  parameters: Match[]; typedParameters: Match[]; functions: Match[]; calls: Match[];
  source: Buffer; declarationsByName: Map<string, Match[]>;
  anonymousClientTypes: Set<string>; localTypes: Set<string>;
}
const isNode = (value: unknown): value is AstNode => Boolean(value && typeof value === 'object'
  && 'type' in value && typeof value.type === 'string' && 'start' in value && typeof value.start === 'number');

/** The index parses once; the guard owns the meaning of each syntax fact. Byte
 * spans preserve the source text used by the exact, named debt inventory. */
function inventory(root: string, file: string, source: string, ast: unknown): Inventory {
  const result: Inventory = { declarations: [], blocks: [], pairs: [], parameters: [],
    typedParameters: [], functions: [], calls: [], source: Buffer.from(source), declarationsByName: new Map(),
    anonymousClientTypes: new Set(), localTypes: new Set() };
  const textOf = (node: AstNode) => result.source.subarray(node.start, node.end).toString();
  const match = (node: AstNode, text?: string): Match => {
    let cleaned: string | undefined;
    return { file, get text() { return cleaned ??= withoutComments(text ?? textOf(node)); },
      range: { byteOffset: { start: node.start, end: node.end } } };
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!isNode(value)) return;
    switch (value.type) {
      case 'ImportDeclaration': {
        const source = value.source;
        if (isNode(source) && typeof source.value === 'string'
          && resolve(root, dirname(file), source.value) === resolve(root, 'apps/web/features/api/main.ts')) {
          for (const specifier of value.specifiers as unknown[]) {
            if (!isNode(specifier) || specifier.type !== 'ImportSpecifier') continue;
            const imported = specifier.imported, local = specifier.local;
            if (isNode(imported) && imported.name === 'AnonymousMainClient' && isNode(local) && typeof local.name === 'string') {
              result.anonymousClientTypes.add(local.name);
            }
          }
        }
        break;
      }
      case 'TSTypeAliasDeclaration':
      case 'TSInterfaceDeclaration':
      case 'TSTypeParameter': {
        const name = value.id ?? value.name;
        if (isNode(name) && typeof name.name === 'string') result.localTypes.add(name.name);
        else if (typeof name === 'string') result.localTypes.add(name);
        break;
      }
      case 'VariableDeclarator': result.declarations.push(match(value)); break;
      case 'BlockStatement': result.blocks.push(match(value)); break;
      case 'Property':
        if (!value.shorthand && !value.method) result.pairs.push(match(value));
        break;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        result.functions.push(match(value));
        const params = (value.params as unknown[]).filter(isNode).map(parameter => {
          // ESTree identifiers cover only the binding name; tree-sitter's
          // required_parameter also includes its TypeScript annotation.
          const annotation = parameter.typeAnnotation;
          return isNode(annotation) ? { ...parameter, end: Math.max(parameter.end, annotation.end) } : parameter;
        });
        if (params.length) {
          // Aggregate parameters need the same containing span as their typed
          // members, including comments and optional/default parameter syntax.
          const span = { ...value, start: params[0]!.start, end: params.at(-1)!.end };
          result.parameters.push(match(span, `(${textOf(span)})`));
          for (const parameter of params) result.typedParameters.push(match(parameter));
        }
        break;
      }
      case 'CallExpression': {
        const callee = value.callee;
        if (isNode(callee)) {
          const call = match(value);
          call.metaVariables = {
            single: { CALLEE: { get text() { return textOf(callee); } } },
            multi: { ARGS: (value.arguments as unknown[]).filter(isNode).map(node => ({ get text() { return textOf(node); } })) },
          };
          result.calls.push(call);
        }
        break;
      }
    }
    for (const child of Object.values(value)) if (typeof child === 'object' && child !== null) visit(child);
  };
  visit(ast);
  // Oxc traversal follows source order, including nested functions. Declaration
  // expansion depends on the nearest preceding binding, not traversal order.
  result.declarations.sort((left, right) => left.range.byteOffset.start - right.range.byteOffset.start);
  for (const declaration of result.declarations) {
    const binding = declaration.text.split('=')[0]!;
    const names = binding.startsWith('{') ? binding.match(/[A-Za-z_$][\w$]*/g) ?? []
      : binding.match(/^[A-Za-z_$][\w$]*/g) ?? [];
    for (const name of new Set(names)) {
      const declarations = result.declarationsByName.get(name) ?? [];
      declarations.push(declaration);
      result.declarationsByName.set(name, declarations);
    }
  }
  return result;
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
  if (!files.length) return [];
  const routes = Object.entries(contract.paths).flatMap(([path, methods]) => Object.entries(methods)
    .filter(([method, operation]) => method === 'get'
      ? operation.parameters?.some(parameter => parameter.in === 'query' && parameter.name === 'actingSubject')
      : method === 'post' && !operation.parameters?.some(parameter => parameter.name.toLowerCase() === 'idempotency-key')
        && Object.values(operation.requestBody?.content ?? {}).some(content => content.schema && schemaActor(content.schema)))
    .map(([method, operation]) => ({ path, method, operation })));
  const indexed = indexedFiles(root, files);
  // Every path this local analyzer can resolve contains a literal API version.
  // Other files can carry aliases, but without that local path they cannot
  // produce a recognized read. Avoid materializing their repository ASTs.
  const readable = files.filter(file => /\bv\d+\b/.test(withoutComments(indexed[file]!.text)));
  const perFile = new Map(readable.map(file => {
    const entry = indexed[file]!;
    return [file, inventory(root, file, entry.text, entry.ast)] as const;
  }));
  const calls = [...perFile.values()].flatMap(item => item.calls);
  const violations: ActingReadViolation[] = [];
  const containingFunction = new WeakMap<Match, Match | undefined>();
  const containingBlocks = new WeakMap<Match, Match[]>();
  for (const call of calls) {
    const rawCallee = code(call.metaVariables?.single.CALLEE?.text ?? '');
    // Only read-shaped members and bare aliases can become recognized reads
    // through binding expansion. Skip lexical scope work for unrelated calls.
    if (!/\.(?:get|post|fetch|fetcher|serverRead|serverFetch)$/.test(rawCallee)
      && !/^(?:(?:globalThis|window)\.)?[A-Za-z_$][\w$]*$/.test(rawCallee)) continue;
    const offset = call.range.byteOffset.start;
    const inventory = perFile.get(call.file)!;
    const scopeOf = (item: Match) => {
      if (!containingFunction.has(item)) containingFunction.set(item, inventory.functions.filter(scope =>
        scope.range.byteOffset.start <= item.range.byteOffset.start && scope.range.byteOffset.end >= item.range.byteOffset.end)
        .sort((a, b) => (a.range.byteOffset.end - a.range.byteOffset.start) - (b.range.byteOffset.end - b.range.byteOffset.start))[0]);
      return containingFunction.get(item);
    };
    const parameterOf = (name: string) => [...inventory.parameters.filter(parameter =>
      new RegExp(`(?:\\(|,)\\s*${name}\\s*\\??\\s*[:,)=]`).test(parameter.text)
      && parameter.range.byteOffset.end < offset && (scopeOf(parameter)?.range.byteOffset.end ?? 0) > offset),
      ...inventory.functions.filter(scope => new RegExp(`^(?:async\\s+)?${name}\\s*=>`).test(scope.text)
        && scope.range.byteOffset.start < offset && scope.range.byteOffset.end > offset)]
      .sort((a, b) => b.range.byteOffset.start - a.range.byteOffset.start)[0];
    const isLocal = (item: Match) => {
      if (item.range.byteOffset.start >= offset) return false;
      if (!containingBlocks.has(item)) containingBlocks.set(item, inventory.blocks.filter(block =>
        block.range.byteOffset.start < item.range.byteOffset.start && block.range.byteOffset.end > item.range.byteOffset.end));
      return containingBlocks.get(item)!.every(block => block.range.byteOffset.start < offset && block.range.byteOffset.end > offset);
    };
    const expand = (text: string, seen = new Set<string>()): string => {
      text = withoutComments(text);
      const name = text.trim().match(/^[A-Za-z_$][\w$]*/)?.[0];
      if (!name || seen.has(name)) return text;
      const declaration = [...inventory.declarationsByName.get(name) ?? []].reverse().find(item => isLocal(item)
        && (new RegExp(`^${name}\\s*(?::[^=]+)?=`).test(item.text)
          || (item.text.startsWith('{') && new RegExp(`\\b${name}\\b`).test(item.text.split('=')[0]!))));
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
      // The unexported brand is produced only by the explicit anonymous adapter
      // overloads. Require that imported type on the actual parameter binding;
      // names, casts, unions and a shadowing persona parameter prove no authority.
      const clientName = expandedClient.match(/^([A-Za-z_$][\w$]*)\.v\d+\b/)?.[1];
      const brandedParameter = clientName && inventory.typedParameters.some(parameter =>
        [...inventory.anonymousClientTypes].some(type => !inventory.localTypes.has(type)
          && new RegExp(`^${clientName}\\??:${type}(?:=|$)`).test(code(parameter.text)))
        && scopeOf(parameter) === scopeOf(parameterOf(clientName) ?? call)
        && parameterOf(clientName)?.range.byteOffset.start! <= parameter.range.byteOffset.start
        && parameterOf(clientName)?.range.byteOffset.end! >= parameter.range.byteOffset.end);
      anonymous = /^mainApiWithToken\(undefined\)(?:\(\))?\.v\d+\b/.test(expandedClient)
        || /^browserMainApi\([^]*\banonymous:true\b[^]*\)\.v\d+\b/.test(expandedClient)
        || Boolean(brandedParameter);
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
      const variable = args[0]?.trim();
      actor = /[?&]actingSubject=/.test(url) || /new URLSearchParams\([^]*\bactingSubject\b/.test(url + queryText)
        || Boolean(variable && new RegExp(`${variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.searchParams\\.set\\(['"]actingSubject['"]`)
          .test(inventory.source.subarray(0, offset).toString()));
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

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export interface CommandOpenApi {
  paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
}
export interface CommandInventory {
  path: string;
  digest: string;
  operations: string[];
  review?: string;
}
interface Match {
  file: string;
  metaVariables: { single: Record<string, { text: string }> };
}

function matches(root: string, directory: string, pattern: string): Match[] {
  const run = Bun.spawnSync({ cmd: [join(root, 'node_modules/.bin/ast-grep'), 'run',
    '--pattern', pattern, '--json=compact', directory], cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (run.exitCode !== 0 && run.exitCode !== 1) throw new Error(Buffer.from(run.stderr).toString());
  return (JSON.parse(Buffer.from(run.stdout).toString() || '[]') as Match[])
    .map(match => ({ ...match, file: relative(root, resolve(root, match.file)) }));
}

/** Ignore argument values, retaining the dynamic Eden route segment they select. */
function routeOf(expression: string, aliases: Map<string, string>, seen = new Set<string>()): string | null {
  const tokens: string[] = expression.match(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|[\w$-]+|[^\s]/g) ?? [];
  const start = tokens.indexOf('v1');
  if (start < 0) {
    const name = tokens[0] ?? '';
    if (seen.has(name) || !aliases.has(name)) return null;
    seen.add(name);
    const prefix = routeOf(aliases.get(name)!, aliases, seen);
    return prefix ? routeOf(`client.${prefix.slice(1).replaceAll('/', '.')}${expression.slice(name.length)}`, aliases, seen) : null;
  }
  const segments = ['v1'];
  for (let index = start + 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '.') { segments.push(tokens[++index]!); continue; }
    if (token === '[' && /^['"]/.test(tokens[index + 1] ?? '') && tokens[index + 2] === ']') {
      segments.push(tokens[index + 1]!.slice(1, -1)); index += 2; continue;
    }
    if (token === '(') {
      let depth = 1;
      while (++index < tokens.length && depth) {
        if (tokens[index] === '(') depth++;
        if (tokens[index] === ')') depth--;
      }
      index--;
      segments.push('*');
      continue;
    }
    return null;
  }
  return `/${segments.join('/')}`;
}

/**
 * Inventory production 202 consumers, including unresolved write aliases. A changed
 * adapter must be reviewed again: a keyword such as "pending" cannot exempt it.
 * Responses come from the generated API, never a second route declaration.
 */
export function commandInventory(root: string, api: CommandOpenApi,
  directory = 'apps/web'): CommandInventory[] {
  const production = (path: string) => !/\.(?:test|stories)\./.test(path) && !/(?:^|[-/])fixtures\.tsx?$/.test(path)
    && !path.includes('/tests/');
  const aliases = new Map<string, Map<string, string>>();
  for (const match of matches(root, directory, 'const $ALIAS = $VALUE')) {
    const variables = match.metaVariables.single;
    if (!production(match.file) || !variables.ALIAS || !variables.VALUE) continue;
    const names = aliases.get(match.file) ?? new Map<string, string>();
    // Ambiguous local names remain unresolved, and still require review below.
    const name = variables.ALIAS.text;
    names.set(name, names.has(name) ? '' : variables.VALUE.text);
    aliases.set(match.file, names);
  }
  const operations = new Map<string, string[]>();
  for (const match of matches(root, directory, '$CALLEE($$$)')) {
    if (!production(match.file)) continue;
    const callee = match.metaVariables.single.CALLEE?.text ?? '';
    const method = callee.match(/(?:\.(post|put|patch|delete)|\[['"](post|put|patch|delete)['"]\])$/);
    if (!method) continue;
    const verb = method[1] ?? method[2]!;
    const route = routeOf(callee.slice(0, method.index), aliases.get(match.file) ?? new Map());
    const declared = route ? Object.keys(api.paths).find(path => path.replace(/\{[^}]+\}/g, '*') === route) : null;
    const response = declared ? api.paths[declared]?.[verb]?.responses : undefined;
    if (declared && !response?.['202']) continue;
    // Set/Map/Headers deletion and IndexedDB writes are not HTTP adapters.
    // An unresolved HTTP-looking alias stays in the inventory for owner review.
    if (!declared && (callee.includes('.objectStore(')
      || verb === 'delete' && !/main|api|client|imports|http|v1/i.test(callee))) continue;
    const operation = declared ? `${verb.toUpperCase()} ${declared}${response?.['202'] ? ' [202]' : ''}`
      : `UNRESOLVED ${verb.toUpperCase()} ${callee}`;
    const list = operations.get(match.file) ?? [];
    list.push(operation);
    operations.set(match.file, list);
  }
  return [...operations].map(([path, calls]) => ({ path: relative(root, join(root, path)),
    digest: createHash('sha256').update(readFileSync(join(root, path))).digest('hex'),
    operations: calls.sort() })).sort((a, b) => a.path.localeCompare(b.path));
}

export function unreviewedCommands(actual: CommandInventory[], reviewed: CommandInventory[]): CommandInventory[] {
  return actual.filter(item => !reviewed.some(prior => prior.path === item.path && prior.digest === item.digest
    && JSON.stringify(prior.operations) === JSON.stringify(item.operations)));
}

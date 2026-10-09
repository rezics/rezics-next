import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Calls that keep the reap owner on PATH for every container a QA process starts. */
export const reapEnvironmentBuilders = [
  'loadDockerEnvironment',
  'composeProcessEnvironment',
  'preserveReapEnvironment',
  'reapOwnerEnvironment',
] as const;

const spawnCallees = new Set([
  'spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'execute',
  'command', 'commandAsync', 'Bun.spawn', 'Bun.spawnSync',
]);

export interface DockerSpawn {
  file: string;
  call: string;
}

type Token = { kind: 'id' | 'str' | 'punct'; text: string; start: number; end: number };

function isIdent(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

/** Tokens outside comments, strings and regular expressions, so a fixture string is not a spawn. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let previous: Token | undefined;
  const canStartRegex = () => {
    if (!previous) return true;
    if (previous.kind === 'punct') return !['.', ')', ']'].includes(previous.text);
    return false;
  };
  while (i < text.length) {
    const char = text[i]!;
    if (char === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i);
      if (i < 0) break;
      continue;
    }
    if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (char === '/' && canStartRegex()) {
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '[') {
          i += 1;
          while (i < text.length && text[i] !== ']') {
            if (text[i] === '\\') i += 1;
            i += 1;
          }
        }
        if (text[i] === '/') { i += 1; break; }
        i += 1;
      }
      while (i < text.length && /[a-z]/i.test(text[i]!)) i += 1;
      continue;
    }
    if (char === '\'' || char === '"') {
      const quote = char;
      const start = i;
      i += 1;
      let value = '';
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') { value += text[i + 1] ?? ''; i += 2; continue; }
        value += text[i];
        i += 1;
      }
      i += 1;
      const token: Token = { kind: 'str', text: value, start, end: i };
      tokens.push(token);
      previous = token;
      continue;
    }
    if (char === '`') {
      const start = i;
      i += 1;
      while (i < text.length && text[i] !== '`') {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '$' && text[i + 1] === '{') {
          i += 2;
          let depth = 1;
          while (i < text.length && depth > 0) {
            if (text[i] === '{') depth += 1;
            else if (text[i] === '}') depth -= 1;
            i += 1;
          }
          continue;
        }
        i += 1;
      }
      i += 1;
      const token: Token = { kind: 'punct', text: '`', start, end: i };
      tokens.push(token);
      previous = token;
      continue;
    }
    if (/\s/.test(char)) { i += 1; continue; }
    if (/[A-Za-z_$]/.test(char)) {
      const start = i;
      i += 1;
      while (i < text.length && isIdent(text[i]!)) i += 1;
      const token: Token = { kind: 'id', text: text.slice(start, i), start, end: i };
      tokens.push(token);
      previous = token;
      continue;
    }
    const paired = char === '=' && text[i + 1] === '>' ? '=>' : char;
    if ('()[]{}.,:=<>?'.includes(char) || paired === '=>') {
      const token: Token = { kind: 'punct', text: paired, start: i, end: i + paired.length };
      tokens.push(token);
      previous = token;
      i += paired.length;
      continue;
    }
    i += 1;
  }
  return tokens;
}

function matching(tokens: Token[], open: number, start: string, end: string): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i]!.kind === 'punct' && tokens[i]!.text === start) depth += 1;
    else if (tokens[i]!.kind === 'punct' && tokens[i]!.text === end) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}

function calleeAt(tokens: Token[], index: number): { name: string; open: number } | undefined {
  const token = tokens[index];
  if (!token || token.kind !== 'id') return undefined;
  let cursor = index + 1;
  let name = token.text;
  if (name === 'Bun' && tokens[cursor]?.text === '.' && tokens[cursor + 1]?.kind === 'id') {
    name = `Bun.${tokens[cursor + 1]!.text}`;
    cursor += 2;
  }
  if (tokens[cursor]?.text === '<') cursor = matching(tokens, cursor, '<', '>') + 1;
  if (tokens[cursor]?.text !== '(') return undefined;
  return { name, open: cursor };
}

function commandOf(tokens: Token[], index: number): string | undefined {
  const token = tokens[index];
  if (!token) return undefined;
  if (token.kind === 'str') return token.text;
  if (token.text === '[') {
    const next = tokens[index + 1];
    if (next?.kind === 'str') return next.text;
  }
  return undefined;
}

function isDockerSpawn(name: string, tokens: Token[], open: number): boolean {
  const close = matching(tokens, open, '(', ')');
  const args: number[] = [];
  let depth = 0;
  for (let i = open; i <= close; i++) {
    const token = tokens[i]!;
    if (token.kind === 'punct' && '([{'.includes(token.text)) depth += 1;
    else if (token.kind === 'punct' && ')]}'.includes(token.text)) depth -= 1;
    if (depth === 1 && token.kind === 'punct' && token.text === ',') args.push(i + 1);
  }
  const positions = [open + 1, ...args];
  if (name === 'docker') return true;
  const slot = name === 'command' || name === 'commandAsync' ? positions[1] : spawnCallees.has(name) ? positions[0] : undefined;
  if (slot === undefined) return false;
  const command = commandOf(tokens, slot);
  return command === 'docker' || command === 'docker-compose';
}

function bindings(tokens: Token[]): { fns: Set<string>; vars: Set<string> } {
  const fns = new Set<string>(reapEnvironmentBuilders);
  const vars = new Set<string>();
  const functions: { name: string; from: number; to: number }[] = [];
  const aliases: { name: string; from: number; to: number }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.text === 'function' && tokens[i + 1]?.kind === 'id' && tokens[i + 2]?.text === '(') {
      const body = tokens.slice(i).findIndex(item => item.text === '{');
      if (body < 0) continue;
      const open = i + body;
      functions.push({ name: tokens[i + 1]!.text, from: open, to: matching(tokens, open, '{', '}') });
    }
    if (token.text !== 'const' && token.text !== 'let') continue;
    const name = tokens[i + 1];
    if (name?.kind !== 'id' || tokens[i + 2]?.text !== '=') continue;
    const value = i + 3;
    if (tokens[value]?.text === '(' || tokens[value]?.text === 'async' || tokens[value]?.kind === 'id'
      && tokens[value + 1]?.text === '=>') {
      const arrow = tokens.slice(value, value + 8).findIndex(item => item.text === '=>');
      if (arrow >= 0) {
        const body = value + arrow + 1;
        if (tokens[body]?.text === '{') {
          functions.push({ name: name.text, from: body, to: matching(tokens, body, '{', '}') });
        } else functions.push({ name: name.text, from: body, to: statementEnd(tokens, body) });
        continue;
      }
    }
    aliases.push({ name: name.text, from: value, to: statementEnd(tokens, value) });
  }
  const callsBuilder = (from: number, to: number, names: Set<string>) => {
    for (let i = from; i <= to; i++) {
      const call = calleeAt(tokens, i);
      if (call && names.has(call.name)) return true;
    }
    return false;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of functions) {
      if (fns.has(item.name) || !callsBuilder(item.from, item.to, fns)) continue;
      fns.add(item.name);
      changed = true;
    }
    for (const item of aliases) {
      if (vars.has(item.name)) continue;
      const call = calleeAt(tokens, item.from);
      const ident = tokens[item.from];
      if ((call && fns.has(call.name)) || (ident?.kind === 'id' && vars.has(ident.text))) {
        vars.add(item.name);
        changed = true;
      }
    }
  }
  return { fns, vars };
}

function statementEnd(tokens: Token[], from: number): number {
  let depth = 0;
  for (let i = from; i < tokens.length; i++) {
    const text = tokens[i]!.text;
    if ('([{'.includes(text)) depth += 1;
    else if (')]}'.includes(text)) {
      if (depth === 0) return i - 1;
      depth -= 1;
    } else if (text === ';' && depth === 0) return i;
  }
  return tokens.length - 1;
}

function callPreserves(tokens: Token[], open: number, close: number, fns: Set<string>, vars: Set<string>): boolean {
  for (let i = open; i <= close; i++) {
    const call = calleeAt(tokens, i);
    if (call && call.open <= close && fns.has(call.name)) return true;
    if (tokens[i]?.kind === 'id' && vars.has(tokens[i]!.text)) return true;
  }
  return false;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function scanDockerSpawnFiles(root: string, files: readonly string[]): DockerSpawn[] {
  const found: DockerSpawn[] = [];
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8');
    const tokens = tokenize(text);
    const bound = bindings(tokens);
    for (let i = 0; i < tokens.length; i++) {
      const call = calleeAt(tokens, i);
      if (!call || !isDockerSpawn(call.name, tokens, call.open)) continue;
      const close = matching(tokens, call.open, '(', ')');
      if (callPreserves(tokens, call.open, close, bound.fns, bound.vars)) continue;
      found.push({ file, call: normalize(text.slice(tokens[i]!.start, tokens[close]!.end)) });
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.call.localeCompare(b.call));
}

function walkTree(root: string, directory: string, found: string[]): void {
  let entries;
  try { entries = readdirSync(join(root, directory), { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.temp' || entry.name === 'dist') continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) walkTree(root, path, found);
    else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(path);
  }
}

/** tests/, scripts/qa and each service's tests. Fixtures outside these trees are scanned on purpose. */
export function dockerOwnershipFiles(root: string): string[] {
  const files: string[] = [];
  walkTree(root, 'tests', files);
  walkTree(root, 'scripts/qa', files);
  let services: string[] = [];
  try { services = readdirSync(join(root, 'services')); } catch { /* no services tree */ }
  for (const service of services) {
    const tests = join('services', service, 'tests');
    try { if (statSync(join(root, tests)).isDirectory()) walkTree(root, tests, files); } catch { /* not a service */ }
  }
  return files.sort();
}

export function scanDockerOwnership(root: string): DockerSpawn[] {
  return scanDockerSpawnFiles(root, dockerOwnershipFiles(root));
}

function counts(items: readonly DockerSpawn[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    const key = `${item.file}\0${item.call}`;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

/** Spawns present in the tree that the debt list does not already name. */
export function uncoveredDockerSpawns(found: readonly DockerSpawn[], debt: readonly DockerSpawn[]): DockerSpawn[] {
  const allowed = counts(debt);
  const extra: DockerSpawn[] = [];
  for (const item of found) {
    const key = `${item.file}\0${item.call}`;
    const left = allowed.get(key) ?? 0;
    if (left > 0) allowed.set(key, left - 1);
    else extra.push(item);
  }
  return extra;
}

/** Debt entries whose spawn is gone. The list stays exact as calls are converted. */
export function staleDockerSpawnDebt(found: readonly DockerSpawn[], debt: readonly DockerSpawn[]): DockerSpawn[] {
  const present = counts(found);
  const stale: DockerSpawn[] = [];
  for (const item of debt) {
    const key = `${item.file}\0${item.call}`;
    const left = present.get(key) ?? 0;
    if (left > 0) present.set(key, left - 1);
    else stale.push(item);
  }
  return stale;
}

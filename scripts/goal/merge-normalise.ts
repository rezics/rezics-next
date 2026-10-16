import { type Lex } from './tasks.ts';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, lstatSync, readlinkSync, readFileSync, renameSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { git } from './ledger.ts';
import { type Task } from './types.ts';

function freshLex(): Lex {
  return { depth: 0, block: false, single: false, double: false, template: false };
}

// One scanner for chain splitting and semicolon stripping, so both agree on where a call ends.
// Strings and comments are opaque; composition roots do not put `${}` braces in these chains.
function lexAdvance(text: string, lex: Lex, keep: boolean): { lex: Lex; text: string } {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];
    const copy = (value: string) => { if (keep) out += value; };
    if (lex.block) {
      copy(c);
      if (c === '*' && next === '/') { copy('/'); i++; lex.block = false; }
      continue;
    }
    if (lex.single || lex.double || lex.template) {
      copy(c);
      const quote = lex.single ? "'" : lex.double ? '"' : '`';
      if (c === '\\' && next !== undefined) { copy(next); i++; continue; }
      if (c === quote) { lex.single = lex.double = lex.template = false; }
      continue;
    }
    if (c === '/' && next === '/') {
      const nl = text.indexOf('\n', i);
      if (nl < 0) { copy(text.slice(i)); break; }
      copy(text.slice(i, nl));
      i = nl - 1;
      continue;
    }
    if (c === '/' && next === '*') { copy('/*'); i++; lex.block = true; continue; }
    if (c === "'") { copy(c); lex.single = true; continue; }
    if (c === '"') { copy(c); lex.double = true; continue; }
    if (c === '`') { copy(c); lex.template = true; continue; }
    if (c === '(' || c === '{' || c === '[') { copy(c); lex.depth++; continue; }
    if (c === ')' || c === '}' || c === ']') { copy(c); lex.depth = Math.max(0, lex.depth - 1); continue; }
    if (c === ';' && lex.depth === 0) continue;
    copy(c);
  }
  return { lex, text: out };
}

function stripDepth0Semicolons(text: string): string {
  return lexAdvance(text, freshLex(), true).text;
}

interface UseCall { lines: string[]; use: boolean }

function splitFluent(lines: string[]): { head: string[]; calls: UseCall[] } {
  const head: string[] = [];
  const calls: UseCall[] = [];
  let current: string[] | null = null;
  let use = false;
  let lex = freshLex();
  const push = () => {
    if (!current) return;
    calls.push({ lines: current, use });
    current = null;
  };
  for (const line of lines) {
    if (lex.depth === 0 && !lex.block && /^\s*\.\w+/.test(line)) {
      push();
      current = [line];
      use = /^\s*\.use\(/.test(line);
    } else if (current) current.push(line);
    else head.push(line);
    lex = lexAdvance(line, lex, false).lex;
  }
  push();
  return { head, calls };
}

function insertSemicolon(line: string): string {
  const comment = /[ \t]*\/\/.*$/.exec(line);
  const code = comment ? line.slice(0, comment.index) : line;
  return `${code.trimEnd()};${comment ? comment[0] : ''}`;
}

function renderCall(lines: string[], terminate: boolean): string[] {
  const stripped = stripDepth0Semicolons(lines.join('\n')).split('\n');
  if (!terminate) return stripped;
  const last = stripped.length - 1;
  stripped[last] = insertSemicolon(stripped[last] ?? '');
  return stripped;
}

const ELYSIA_HEAD = /^\s*(?:const|let)\s+\w+\s*=\s*new\s+Elysia\(\)\s*;?\s*$/;
const RETURN_ELYSIA = /^\s*return\s+new\s+Elysia\(\)\s*;?\s*$/;
const RETURN_IDENT = /^\s*return\s+[A-Za-z_$][\w$]*\s*;?\s*$/;

function isChainHead(line: string, next: string | undefined): boolean {
  if (ELYSIA_HEAD.test(line) || RETURN_ELYSIA.test(line)) return true;
  return RETURN_IDENT.test(line) && !!next && /^\s*\.\w+/.test(next);
}

function collectChain(lines: string[], start: number): { chain: string[]; next: number } {
  const chain = [lines[start]!];
  let lex = lexAdvance(lines[start]!, freshLex(), false).lex;
  let i = start + 1;
  while (i < lines.length) {
    const line = lines[i]!;
    if (lex.depth === 0 && !lex.block && !/^\s*\.\w+/.test(line)) break;
    chain.push(line);
    lex = lexAdvance(line, lex, false).lex;
    i++;
  }
  return { chain, next: i };
}

function renderChain(lines: string[]): string[] {
  const { head, calls } = splitFluent(lines);
  if (!calls.length) return lines;
  const seen = new Set<string>();
  const kept: UseCall[] = [];
  for (const call of calls) {
    if (call.use) {
      const key = stripDepth0Semicolons(call.lines.join('\n')).trim();
      if (seen.has(key)) continue;
      seen.add(key);
    }
    kept.push(call);
  }
  return [
    ...stripDepth0Semicolons(head.join('\n')).split('\n'),
    ...kept.flatMap((call, index) => renderCall(call.lines, index === kept.length - 1)),
  ];
}

/** Drop exact duplicate `.use(…)` calls inside each chain and leave one terminating semicolon.
 * Function signatures and every other line are copied through. */
export function normalizeUseChains(source: string): string {
  const lines = source.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    if (!isChainHead(lines[i] ?? '', lines[i + 1])) {
      out.push(lines[i] ?? '');
      i++;
      continue;
    }
    const collected = collectChain(lines, i);
    out.push(...renderChain(collected.chain));
    i = collected.next;
  }
  return out.join('\n');
}

/** Parse diagnostics only (`bun build --no-bundle`). TypeScript 7 no longer exports `createSourceFile`.
 * Empty when the file parses. The message carries the repository path, line and error. */
export function compositionSyntaxFailure(file: string, source: string): string | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'goalctl-parse-'));
  try {
    const path = join(dir, basename(file));
    writeFileSync(path, source);
    const run = spawnSync('bun', ['build', '--no-bundle', path, '--outdir', join(dir, 'out')],
      { encoding: 'utf8', timeout: 30_000 });
    if (run.status === 0) return undefined;
    const blob = `${run.stderr ?? ''}\n${run.stdout ?? ''}\n${run.error?.message ?? ''}`.trim();
    const message = /error: ([^\n]+)/.exec(blob)?.[1]?.trim()
      ?? blob.split('\n').map(line => line.trim()).filter(Boolean).at(-1)
      ?? 'parse failed';
    const at = /\bat [^\n]*:(\d+):(\d+)/.exec(blob);
    return `${file}:${at ? `${at[1]}:${at[2]}` : '1:1'}: ${message}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface CompositionMerge {
  files: { file: string; source: string }[];
  /** False means the task is `conflict` and main must not be fast-forwarded. */
  fastForward: boolean;
  state?: 'conflict';
  /** Each failing composition root's path and parse error. */
  error?: string;
}

/** Normalize, then parse. A failure here is the merge refusal: do not fast-forward `main`. */
export function prepareCompositionMerge(files: readonly { file: string; source: string }[]): CompositionMerge {
  const normalized = files.map(file => ({ file: file.file, source: normalizeUseChains(file.source) }));
  const failures = normalized.flatMap(file => {
    const failure = compositionSyntaxFailure(file.file, file.source);
    return failure ? [failure] : [];
  });
  if (!failures.length) return { files: normalized, fastForward: true };
  return { files: normalized, fastForward: false, state: 'conflict', error: failures.join('\n  ') };
}

/**
 * Migrations a branch adds that sort before a migration already on main. Fixture manifests refuse a
 * migration inserted before applied ones, so such a branch must renumber before it merges.
 */
export function migrationsBelowMain(added: readonly string[], listMain: (directory: string) => string[]): string[] {
  const late: string[] = [];
  const byDirectory = new Map<string, string[]>();
  for (const path of added) {
    const match = /^(.*\/migrations\/[^/]+)\/(\d+)_[^/]+\.sql$/.exec(path);
    if (match) byDirectory.set(match[1]!, [...byDirectory.get(match[1]!) ?? [], path]);
  }
  for (const [directory, paths] of byDirectory) {
    const own = new Set(paths.map(path => path.slice(directory.length + 1)));
    const highest = Math.max(0, ...listMain(directory).filter(name => !own.has(name))
      .map(name => Number(/^(\d+)_/.exec(name)?.[1] ?? 0)));
    for (const path of paths) {
      const number = Number(/\/(\d+)_[^/]+\.sql$/.exec(path)![1]);
      if (number <= highest) late.push(`${path} (main already has ${highest})`);
    }
  }
  return late;
}

export interface MigrationRename { from: string; to: string; number: number; next: number }

const migrationPath = /^(.*\/migrations\/[^/]+)\/(\d+)_[^/]+\.sql$/;
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const numberToken = (number: number) => `(?<![\\w$])0*${number}(?![\\w$]|\\.\\d)`;

/** Numeric data alone cannot prove a reference: only named migration/version declarations qualify. */
function migrationNumberContexts(number: number): RegExp[] {
  const token = numberToken(number);
  return [new RegExp(`\\bmigration\\s+(${token})`, 'gi'),
    new RegExp(`\\b(?:const|let|var)\\s+(?:[\\w$]*(?:migration|version)[\\w$]*)(?:\\s*:\\s*number)?\\s*=\\s*(['"]?)(${token})\\1(?![\\d.])`, 'gi')];
}

/** Plan every rewrite before mutating: uncertainty leaves a clean branch for manual renumbering. */
export function normalizeMigrations(worktree: string, branch: string, base = 'main'): string | MigrationRename[] {
  // https://git-scm.com/docs/git-diff documents the A filter; existing main migrations may not move.
  const added = git(worktree, ['diff', '--find-renames', '--diff-filter=A', '--name-only', `${base}..${branch}`])
    .split('\n').filter(path => migrationPath.test(path));
  const listMain = (directory: string) => git(worktree, ['ls-tree', '--name-only', base, `${directory}/`])
    .split('\n').filter(Boolean).map(path => basename(path));
  const directories = new Set(added.map(path => dirname(path)));
  const renames: MigrationRename[] = [];
  for (const directory of directories) {
    const highest = Math.max(0, ...listMain(directory).map(name => Number(/^(\d+)_/.exec(name)?.[1] ?? 0)));
    const own = added.filter(path => dirname(path) === directory)
      .sort((a, b) => Number(migrationPath.exec(a)![2]) - Number(migrationPath.exec(b)![2]) || a.localeCompare(b));
    if (!own.some(path => Number(migrationPath.exec(path)![2]) <= highest)) continue;
    // Move the directory's entire added sequence to keep its order, including additions above main.
    const occupied = new Set(readdirSync(join(worktree, directory)).map(name => Number(/^(\d+)_/.exec(name)?.[1] ?? 0)));
    let next = highest;
    for (const from of own) {
      do { next++; } while (occupied.has(next));
      if (!Number.isSafeInteger(next)) return `${directory}: migration number exceeds the safe integer range; renumber by hand`;
      occupied.add(next);
      const digits = migrationPath.exec(from)![2]!;
      const to = join(directory, basename(from).replace(/^\d+/, String(next).padStart(Math.max(3, digits.length), '0')));
      renames.push({ from, to, number: Number(digits), next });
    }
  }
  if (!renames.length) return [];
  const plannedPaths = new Map(renames.map(rename => [rename.from, rename.to]));
  const early = migrationsBelowMain(added.map(path => plannedPaths.get(path) ?? path), listMain);
  if (early.length) return `planned migrations still fall below main:\n  ${early.join('\n  ')}`;
  const changed = new Set(git(worktree, ['diff', '--name-only', `${base}..${branch}`]).split('\n').filter(Boolean));
  const files = git(worktree, ['ls-files', '-z']).split('\0').filter(Boolean);
  const writes = new Map<string, string>();
  const numbers = new Set(renames.map(rename => rename.number));
  for (const file of files) {
    const path = join(worktree, file);
    const kind = lstatSync(path);
    if (!kind.isFile() && !kind.isSymbolicLink()) continue;
    const source = kind.isSymbolicLink() ? readlinkSync(path) : readFileSync(path, 'utf8');
    const self = renames.find(rename => rename.from === file);
    const selfToken = self ? new RegExp(`(?<!\\d)0*${self.number}(?!\\d)`, 'g') : undefined;
    const mentions = [...numbers].filter(number => migrationNumberContexts(number).some(pattern => pattern.test(source))
      || renames.some(rename => rename.number === number
        && new RegExp(`(?<![\\w.-])${escapePattern(basename(rename.from))}(?![\\w.-])`).test(source))
      || (self?.number === number && selfToken?.test(source)));
    if (!mentions.length) continue;
    if (!changed.has(file)) return `${file} references old migration number ${mentions.join(', ')} outside the task's changed files; renumber by hand`;
    if (!kind.isFile()) return `${file}: migration reference is in a symbolic link; renumber by hand`;
    const edits = new Map<number, { end: number; value: string }>();
    const addEdit = (start: number, end: number, value: string) => {
      const existing = edits.get(start);
      if (existing && (existing.end !== end || existing.value !== value)) throw new Error(`${file}: ambiguous migration reference; renumber by hand`);
      edits.set(start, { end, value });
    };
    // Qualified filenames select the directory even when two owners used the same basename.
    for (const rename of renames) {
      const pattern = new RegExp(`(?<![\\w.-])${escapePattern(rename.from)}(?![\\w.-])`, 'g');
      for (const match of source.matchAll(pattern)) {
        const start = match.index + rename.from.length - basename(rename.from).length;
        addEdit(start, start + /^\d+/.exec(basename(rename.from))![0].length, /^\d+/.exec(basename(rename.to))![0]);
      }
    }
    for (const rename of renames) {
      const pattern = new RegExp(`(?<![\\w.-])${escapePattern(basename(rename.from))}(?![\\w.-])`, 'g');
      for (const match of source.matchAll(pattern)) {
        if (edits.has(match.index)) continue;
        const qualified = /([\w./-]+\/migrations\/[^/]+)\/$/.exec(source.slice(0, match.index));
        if (qualified) return `${file}: filename ${basename(rename.from)} refers to a directory not being renumbered (${qualified[1]}); renumber by hand`;
        const targets = new Set(renames.filter(other => basename(other.from) === basename(rename.from)).map(other => other.to));
        if (targets.size !== 1) return `${file}: filename ${basename(rename.from)} is ambiguous across directories; renumber by hand`;
        addEdit(match.index, match.index + /^\d+/.exec(match[0])![0].length, /^\d+/.exec(basename(rename.to))![0]);
      }
    }
    for (const number of mentions) {
      // These contexts identify a migration reference without guessing what other numeric data means.
      for (const pattern of migrationNumberContexts(number)) {
        for (const match of source.matchAll(pattern)) {
          const old = match[match.length - 1]!;
          const start = match.index + match[0].lastIndexOf(old);
          if ([...edits].some(([offset, edit]) => start >= offset && start < edit.end)) continue;
          const candidates = self ? renames.filter(rename => dirname(rename.from) === dirname(file)) : renames;
          const targets = new Set(candidates.filter(rename => rename.number === number).map(rename => rename.next));
          if (targets.size !== 1) return `${file}: migration ${number} is ambiguous across directories; renumber by hand`;
          addEdit(start, start + old.length, String([...targets][0]));
        }
      }
    }
    if (self && selfToken) {
      selfToken.lastIndex = 0;
      for (const match of source.matchAll(selfToken)) {
        if (![...edits].some(([start, edit]) => match.index >= start && match.index < edit.end)) {
          return `${file}: its own migration number ${self.number} occurs outside a proven migration context; renumber by hand`;
        }
      }
    }
    let rewritten = source;
    for (const [start, edit] of [...edits].sort(([a], [b]) => b - a)) rewritten = rewritten.slice(0, start) + edit.value + rewritten.slice(edit.end);
    if (rewritten !== source) {
      if (!Buffer.from(source).equals(readFileSync(path))) return `${file}: migration references are not UTF-8 text; renumber by hand`;
      writes.set(file, rewritten);
    }
  }
  for (const rename of renames) {
    if (!lstatSync(join(worktree, rename.from)).isFile()) return `${rename.from}: migration is not a regular file; renumber by hand`;
  }
  for (const [file, source] of writes) writeFileSync(join(worktree, file), source);
  for (const rename of renames) renameSync(join(worktree, rename.from), join(worktree, rename.to));
  git(worktree, ['add', '--', ...new Set([...writes.keys(), ...renames.flatMap(rename => [rename.from, rename.to])])]);
  git(worktree, ['commit', '-q', '-m', 'Normalize migration numbers after rebase (goalctl)']);
  console.log(`Migration normalization:\n  ${renames.map(rename => `${rename.from} -> ${rename.to}`).join('\n  ')}`);
  return renames;
}

/** Recover a landing from git alone, including a removed worktree and cherry-picked commits.
 * Verbatim patches preserve meaningful whitespace; every outstanding commit must be accounted for. */
export function landedTaskCommit(repo: string, task: Pick<Task, 'base' | 'branch' | 'mergedCommit'>, patches = true): string | undefined {
  const ancestor = (commit: string) => spawnSync('git', ['merge-base', '--is-ancestor', commit, 'main'], { cwd: repo }).status === 0;
  const head = git(repo, ['rev-parse', '--verify', task.branch], true);
  if (!head) return task.mergedCommit && ancestor(task.mergedCommit) ? task.mergedCommit : undefined;
  if (head === task.base) return undefined;
  if (ancestor(head)) return head;
  if (!patches) return undefined;
  const patch = (commit: string) => git(repo, ['patch-id', '--verbatim'], false,
    { input: git(repo, ['show', '--format=', commit]) }).split(' ')[0];
  const outstanding = git(repo, ['rev-list', '--reverse', `${task.base}..${head}`, '--not', 'main']).split('\n').filter(Boolean).map(patch);
  if (!outstanding.length || outstanding.some(value => !value)) return undefined;
  let matched = 0;
  for (const commit of git(repo, ['rev-list', '--reverse', '--first-parent', `${task.base}..main`]).split('\n').filter(Boolean)) {
    if (patch(commit) === outstanding[matched] && ++matched === outstanding.length) return commit;
  }
  return undefined;
}

/** A hand-landed cherry-pick is attributable only across its contiguous patch-equivalent suffix.
 * An unknown boundary is recorded with zero width, so unrelated manager commits cannot be blamed on this task. */
export function landedBoundary(repo: string, task: Pick<Task, 'base' | 'branch'>, after: string): string {
  if (!git(repo, ['rev-parse', '--verify', task.branch], true)) return after;
  const patch = (commit: string) => {
    const diff = git(repo, ['show', '--format=', commit]);
    // Whitespace can change strings and indentation-sensitive files; stable patch IDs discard it.
    return git(repo, ['patch-id', '--verbatim'], false, { input: diff }).split(' ')[0];
  };
  const patches = new Set(git(repo, ['rev-list', `${task.base}..${task.branch}`, '--not', 'main']).split('\n').filter(Boolean).map(patch));
  patches.delete('');
  if (!patches.size && git(repo, ['rev-parse', task.branch]) === after) {
    const reflog = git(repo, ['reflog', 'show', 'main', '--format=%H%x09%gs']).split('\n');
    if (reflog[0]?.startsWith(`${after}\tmerge ${task.branch}: Fast-forward`) && reflog[1]) return reflog[1].split('\t')[0]!;
  }
  let before = after;
  for (const commit of git(repo, ['rev-list', '--first-parent', `${task.base}..${after}`]).split('\n').filter(Boolean)) {
    if (!patches.has(patch(commit))) break;
    before = git(repo, ['rev-parse', `${commit}^`]);
  }
  return before;
}

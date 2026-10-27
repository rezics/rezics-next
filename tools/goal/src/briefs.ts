import { readFileSync } from 'node:fs';
import { isAbsolute, win32 } from 'node:path';
import type { Brief, TaskKind } from './types.ts';

export type RiskOwnership = { version: number; areas: Record<string, string[]> };
/** Deliberately small path language: literals, *, ?, and whole-segment **. */
export function validatePath(pattern: string): void {
  if (
    !pattern ||
    isAbsolute(pattern) ||
    win32.isAbsolute(pattern) ||
    /[\\\[\]{}\x00]/.test(pattern) ||
    pattern.split('/').some((s) => !s || s === '.' || s === '..') ||
    pattern.startsWith('.temp/') ||
    pattern.split('/').some((s) => s.includes('**') && s !== '**')
  )
    throw new Error(`invalid declared path: ${pattern}`);
}
function segmentOverlap(a: string, b: string): boolean {
  const seen = new Set<string>();
  function walk(i: number, j: number): boolean {
    const key = `${i}:${j}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (i === a.length && j === b.length) return true;
    const x = a[i],
      y = b[j];
    if (x === '*' && walk(i + 1, j)) return true;
    if (y === '*' && walk(i, j + 1)) return true;
    if (x === undefined || y === undefined) return false;
    if (x === '*' || x === '?' || y === '*' || y === '?' || x === y)
      return walk(x === '*' ? i : i + 1, y === '*' ? j : j + 1);
    return false;
  }
  return walk(0, 0);
}
/** Intersect the glob languages rather than testing a glob string as though it were a filename. */
export function pathsOverlap(a: string, b: string): boolean {
  const left = a.split('/'),
    right = b.split('/'),
    seen = new Set<string>();
  function walk(i: number, j: number): boolean {
    const key = `${i}:${j}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (i === left.length && j === right.length) return true;
    const x = left[i],
      y = right[j];
    if (x === '**' && walk(i + 1, j)) return true;
    if (y === '**' && walk(i, j + 1)) return true;
    if (x === undefined || y === undefined) return false;
    if ((x === '**' || y === '**' || segmentOverlap(x, y)) && walk(x === '**' ? i : i + 1, y === '**' ? j : j + 1))
      return true;
    return false;
  }
  return walk(0, 0);
}
export function matchesPath(path: string, patterns: readonly string[]): boolean {
  // A concrete path is a literal pattern; reject metacharacters to avoid granting extra scope.
  if (/[*?]/.test(path)) return false;
  return patterns.some((pattern) => pathsOverlap(path, pattern));
}
export function readRiskOwnership(file: string): RiskOwnership {
  const value = JSON.parse(readFileSync(file, 'utf8')) as RiskOwnership;
  if (value.version !== 1 || !value.areas || typeof value.areas !== 'object')
    throw new Error('invalid risk ownership table');
  for (const patterns of Object.values(value.areas)) {
    if (!Array.isArray(patterns)) throw new Error('risk ownership patterns must be arrays');
    patterns.forEach(validatePath);
  }
  return value;
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function list(value: unknown, label: string, nonempty = false): string[] {
  if (!Array.isArray(value) || value.some((x) => typeof x !== 'string' || !x.trim()) || (nonempty && !value.length))
    throw new Error(`${label} must be a string list`);
  return value;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value;
}
function boolean(value: unknown, label: string, fallback?: boolean): boolean {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}
/** Point an existing brief at the stabilize branch without changing its other front matter. */
export function withStabilizeTarget(markdown: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) throw new Error('brief needs Markdown front matter');
  const newline = match[0].includes('\r\n') ? '\r\n' : '\n';
  const body = /^target:/m.test(match[1]!)
    ? match[1]!.replace(/^target:.*$/m, 'target: stabilize')
    : `${match[1]!}${newline}target: stabilize`;
  const end = (match.index ?? 0) + match[0].length;
  return `${markdown.slice(0, match.index)}---${newline}${body}${newline}---${markdown.slice(end)}`;
}
export function parseBrief(markdown: string, ownership: RiskOwnership): Brief {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) throw new Error('brief needs Markdown front matter');
  const raw = object(Bun.YAML.parse(match[1]!), 'front matter');
  const kinds: TaskKind[] = [
    'implementation',
    'interface',
    'bulk-text',
    'claim',
    'specification',
    'research',
    'mechanical',
  ];
  if (!kinds.includes(raw.kind as TaskKind)) throw new Error('unsupported brief kind');
  const acceptance = object(raw.acceptance, 'acceptance');
  const estimate = object(raw.estimate, 'estimate');
  for (const key of ['lines', 'files'])
    if (!Number.isSafeInteger(estimate[key]) || (estimate[key] as number) < 1)
      throw new Error(`estimate.${key} must be positive`);
  if (raw.target !== undefined && raw.target !== 'stabilize')
    throw new Error('brief target must be stabilize; a brief without a target line goes to dev');
  const brief: Brief = {
    goal: text(raw.goal, 'goal'),
    manager: text(raw.manager ?? raw.goal, 'manager'),
    kind: raw.kind as TaskKind,
    paths: list(raw.paths, 'paths', true),
    riskAreas: list(raw.riskAreas, 'riskAreas'),
    ...(raw.target === 'stabilize' ? { target: 'stabilize' as const } : {}),
    ...(raw.model === undefined ? {} : { model: text(raw.model, 'model') }),
    ...(raw.effort === undefined ? {} : { effort: text(raw.effort, 'effort') }),
    acceptance: {
      command: list(acceptance.command, 'acceptance.command', true),
      tests: list(acceptance.tests, 'acceptance.tests', true),
      failing: boolean(acceptance.failing, 'acceptance.failing', false),
    },
    estimate: { lines: estimate.lines as number, files: estimate.files as number },
    criticalPath: boolean(raw.criticalPath, 'criticalPath'),
    waiting: list(raw.waiting, 'waiting'),
    after: list(raw.after ?? [], 'after'),
    inseparable: boolean(raw.inseparable, 'inseparable', false),
    citesSources: boolean(raw.citesSources, 'citesSources', false),
    hostileInput: boolean(raw.hostileInput, 'hostileInput', false),
    markdown,
  };
  brief.paths.forEach(validatePath);
  for (const area of brief.riskAreas)
    if (!Object.hasOwn(ownership.areas, area)) throw new Error(`unknown risk area: ${area}`);
  for (const [area, patterns] of Object.entries(ownership.areas)) {
    if (
      brief.paths.some((path) => patterns.some((pattern) => pathsOverlap(path, pattern))) &&
      !brief.riskAreas.includes(area)
    )
      throw new Error(`declared paths touch undeclared risk area: ${area}`);
  }
  return brief;
}

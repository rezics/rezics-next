import { readFileSync } from 'node:fs';
import { isAbsolute, win32 } from 'node:path';
import type { AcceptancePlacement, Brief, BriefContinuation, TaskKind } from './types.ts';
import { parseProofMetadata } from './verification.ts';

export type RiskOwnership = { version: number; areas: Record<string, string[]> };
/**
 * A worker's prompt is one argument, which Linux limits to 128 KiB: a 127 KB brief failed every launch with E2BIG
 * (2026-10-29). Briefs link evidence files instead of pasting them. Declared paths share this bound.
 */
export const MAX_BRIEF_BYTES = 64 * 1024;
/** Visited (i, j) cells; wildcard products larger than this stall dispatch. */
const MAX_PATH_MATCH_STATES = 1_000_000;
function pathMatchExceeded(): never {
  throw new Error('path pattern matching exceeded the supported bound; shorten wildcards or split the pattern');
}
/** Deliberately small path language: literals, *, ?, and whole-segment **. */
export function validatePath(pattern: string): void {
  if (pattern.length > MAX_BRIEF_BYTES)
    throw new Error(
      `declared path is ${pattern.length} characters; keep each pattern under ${MAX_BRIEF_BYTES} characters`,
    );
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
function overlapReachable(
  lengthA: number,
  lengthB: number,
  expand: (i: number, j: number, push: (ni: number, nj: number) => void) => void,
): boolean {
  const width = lengthB + 1;
  const seen = new Set<number>();
  const stack = [0];
  while (stack.length) {
    const encoded = stack.pop()!;
    if (seen.has(encoded)) continue;
    seen.add(encoded);
    if (seen.size > MAX_PATH_MATCH_STATES) pathMatchExceeded();
    const i = Math.floor(encoded / width);
    const j = encoded - i * width;
    if (i === lengthA && j === lengthB) return true;
    expand(i, j, (ni, nj) => stack.push(ni * width + nj));
  }
  return false;
}
function segmentOverlap(a: string, b: string): boolean {
  return overlapReachable(a.length, b.length, (i, j, push) => {
    const x = a[i],
      y = b[j];
    if (x === '*') push(i + 1, j);
    if (y === '*') push(i, j + 1);
    if (x === undefined || y === undefined) return;
    if (x === '*' || x === '?' || y === '*' || y === '?' || x === y) push(x === '*' ? i : i + 1, y === '*' ? j : j + 1);
  });
}
/** Intersect the glob languages rather than testing a glob string as though it were a filename. */
export function pathsOverlap(a: string, b: string): boolean {
  const left = a.split('/'),
    right = b.split('/');
  return overlapReachable(left.length, right.length, (i, j, push) => {
    const x = left[i],
      y = right[j];
    if (x === '**') push(i + 1, j);
    if (y === '**') push(i, j + 1);
    if (x === undefined || y === undefined) return;
    if (x === '**' || y === '**' || segmentOverlap(x, y)) push(x === '**' ? i : i + 1, y === '**' ? j : j + 1);
  });
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
    throw new Error(`${label} must be a${nonempty ? ' non-empty' : ''} string list`);
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
function continuation(value: unknown): BriefContinuation | undefined {
  if (value === undefined) return undefined;
  const raw = object(value, 'continuation');
  const taskId = text(raw.taskId, 'continuation.taskId');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(taskId)) throw new Error('continuation.taskId must be a valid task ID');
  if (!Number.isSafeInteger(raw.expectedAttempt) || (raw.expectedAttempt as number) < 1)
    throw new Error('continuation.expectedAttempt must be a positive integer');
  return { taskId, expectedAttempt: raw.expectedAttempt as number };
}
/** Read only the optional existing-task marker so claim recovery can distinguish safe retries from new dispatches. */
export function readBriefContinuation(markdown: string): BriefContinuation | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) return undefined;
  return continuation(object(Bun.YAML.parse(match[1]!), 'front matter').continuation);
}
function localTestFile(path: string): boolean {
  return (
    /^apps\/web\/tests\/[A-Za-z0-9._/-]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) &&
    !path.split('/').some((part) => part === '.' || part === '..') &&
    !/(?:^|[/.])(?:native|e2e|integration|host|database|db|browser|playwright|stack)(?:[/.]|$)/i.test(path) &&
    !/(?:^|[/.])sql[-_.]?compiler(?:[/.]|$)/i.test(path)
  );
}
function localBunTests(argv: readonly string[], appRelative: boolean): boolean {
  if (argv[0] !== 'bun' || argv[1] !== 'test') return false;
  let files = 0;
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === '-t' || value === '--test-name-pattern') {
      if (!argv[index + 1] || argv[index + 1]!.startsWith('-')) return false;
      index += 1;
      continue;
    }
    if (appRelative) {
      if (!value.startsWith('tests/') || !localTestFile(`apps/web/${value}`)) return false;
    } else if (!localTestFile(value)) return false;
    files += 1;
  }
  return files > 0;
}
function focusedWebCommand(argv: readonly string[]): boolean {
  return (
    argv.length >= 7 &&
    argv[0] === 'bun' &&
    argv[1] === 'apps/web/scripts/focused.ts' &&
    argv[2] === '--private-network' &&
    argv[3] === '--' &&
    localBunTests(argv.slice(4), true)
  );
}
/** Only the two audited Web environment changes may prefix the focused runner. */
function localEnvironmentCommand(argv: readonly string[]): readonly string[] | undefined {
  if (argv[0] !== 'env') return argv;
  let index = 1;
  let changed = false;
  const seen = new Set<string>();
  while (index < argv.length) {
    if (argv[index] === '-u') {
      const name = argv[index + 1];
      if (name !== 'KERNEL_ORIGIN' || seen.has('KERNEL_ORIGIN')) return undefined;
      seen.add('KERNEL_ORIGIN');
      changed = true;
      index += 2;
      continue;
    }
    if (argv[index] === 'PUBLIC_ORIGIN=http://127.0.0.1:3000') {
      if (seen.has('PUBLIC_ORIGIN')) return undefined;
      seen.add('PUBLIC_ORIGIN');
      changed = true;
      index += 1;
      continue;
    }
    break;
  }
  return changed && index < argv.length ? argv.slice(index) : undefined;
}
function localBunCommand(rawArgv: readonly string[]): boolean {
  if (rawArgv[0] === 'env') {
    const argv = localEnvironmentCommand(rawArgv);
    return argv !== undefined && focusedWebCommand(argv);
  }
  const argv = rawArgv;
  if (
    (argv.length === 5 &&
      argv[0] === 'bun' &&
      argv[1] === 'run' &&
      argv[2] === '--cwd' &&
      argv[3] === 'apps/web' &&
      argv[4] === 'typecheck') ||
    (argv.length === 4 &&
      argv[0] === 'bun' &&
      argv[1] === 'run' &&
      argv[2] === '--cwd=apps/web' &&
      argv[3] === 'typecheck')
  )
    return true;
  if (focusedWebCommand(argv)) return true;
  return localBunTests(argv, false);
}
/** Split only the audited `sh -c 'bun ... && bun ...'` form; shell expansion and other operators stay unsupported. */
function localShellCommands(script: string): string[][] | undefined {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let hasWord = false;
  let quote: "'" | '"' | undefined;
  const finishWord = () => {
    if (!hasWord) return;
    words.push(word);
    word = '';
    hasWord = false;
  };
  const finishCommand = () => {
    finishWord();
    if (!words.length) return false;
    commands.push(words);
    words = [];
    return true;
  };
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === '$' || char === '`' || char === '\\' || char === '\n' || char === '\r') return undefined;
      else word += char;
      hasWord = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      hasWord = true;
      continue;
    }
    if (script.startsWith('&&', index)) {
      if (!finishCommand()) return undefined;
      index += 1;
      continue;
    }
    if (';&|<>$`\\\n\r'.includes(char)) return undefined;
    if (/\s/.test(char)) {
      finishWord();
      continue;
    }
    word += char;
    hasWord = true;
  }
  if (quote || !finishCommand()) return undefined;
  return commands;
}
/** Local checks are Web typechecking or explicitly named Web unit/component test files. */
export function validateLocalAcceptanceCommand(command: readonly string[]): void {
  let outer = Array.from(command);
  if (outer[0] === 'timeout') {
    if (outer.length !== 5 || outer[1] !== '590' || outer[2] !== 'sh' || outer[3] !== '-c') outer = [];
    else outer = outer.slice(2);
  }
  const commands =
    outer.length === 3 && outer[0] === 'sh' && outer[1] === '-c' ? localShellCommands(outer[2]!) : [outer];
  if (commands?.length && commands.every(localBunCommand)) return;
  const text = command.join(' ');
  if (
    /\b(?:services\/|DATABASE_URL|postgres|psql|docker|podman|compose|playwright|vitest|jest)\b|(?:^|[/.])(?:native|e2e|integration|host|database|db)(?:[/.]|$)/i.test(
      text,
    )
  )
    throw new Error('acceptance.placement local rejects native, database, host, and broad-suite check routes');
  throw new Error(
    'acceptance.placement local supports only Web typechecking, explicit unit/component tests, or the audited focused Web runner with its supported environment prefix',
  );
}
/** A control-plane brief that explicitly uses the main-release proof lane. */
export function controlPlaneReleaseBrief(brief: { goal?: unknown; target?: unknown }): boolean {
  return brief.goal === 'control-plane' && (brief.target === 'main' || brief.target === 'stabilize');
}
/**
 * Work integrating into dev, including untargeted control-plane work. Its retries are unlimited and need no approval;
 * control-plane releases, stabilize and proof work keep their own lifecycle limits.
 */
export function devProductBrief(brief: Pick<Brief, 'goal' | 'kind' | 'target'>): boolean {
  return !controlPlaneReleaseBrief(brief) && brief.target !== 'stabilize' && brief.kind !== 'verification';
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
export const BRIEF_KINDS: readonly TaskKind[] = [
  'implementation',
  'interface',
  'bulk-text',
  'claim',
  'specification',
  'research',
  'verification',
  'mechanical',
];
export function parseBrief(markdown: string, ownership: RiskOwnership): Brief {
  const bytes = Buffer.byteLength(markdown, 'utf8');
  if (bytes > MAX_BRIEF_BYTES)
    throw new Error(
      `brief is ${bytes} bytes; keep it under ${MAX_BRIEF_BYTES} bytes and link evidence files instead of pasting them`,
    );
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) throw new Error('brief needs Markdown front matter');
  const raw = object(Bun.YAML.parse(match[1]!), 'front matter');
  if (!BRIEF_KINDS.includes(raw.kind as TaskKind)) throw new Error('unsupported brief kind');
  const goal = text(raw.goal, 'goal');
  const manager = text(raw.manager ?? goal, 'manager');
  const kind = raw.kind as TaskKind;
  if (raw.target === 'main' && goal !== 'control-plane')
    throw new Error('only a control-plane brief can target main; a brief without a target line goes to dev');
  if (raw.target !== undefined && raw.target !== 'stabilize' && raw.target !== 'main')
    throw new Error(
      'brief target must be stabilize or, for control-plane, main; a brief without a target line goes to dev',
    );
  const target = raw.target === 'stabilize' || raw.target === 'main' ? raw.target : undefined;
  const hasFrozenAcceptance = /^\s*(?:`{3,}|~{3,})(?:[^\r\n]*[ \t])?path=/m.test(markdown);
  const ordinaryDevProduct = devProductBrief({ goal, kind, ...(target ? { target } : {}) });
  const acceptance: Record<string, unknown> = raw.acceptance === undefined ? {} : object(raw.acceptance, 'acceptance');
  const commandMissing = acceptance.command === undefined;
  const workerOwnedAcceptance = ordinaryDevProduct && !hasFrozenAcceptance && commandMissing;
  const placement = acceptance.placement;
  if (placement !== undefined && placement !== 'local' && placement !== 'default')
    throw new Error('acceptance.placement must be local or default');
  if (commandMissing && placement !== undefined)
    throw new Error('acceptance.placement requires acceptance.command; omit placement for worker-owned validation');
  if (commandMissing && !workerOwnedAcceptance)
    throw new Error(
      'acceptance.command is required for main/stabilize releases, verification, and frozen acceptance briefs; provide a non-empty argv list',
    );
  if (acceptance.tests === undefined && !workerOwnedAcceptance)
    throw new Error('acceptance.tests is required with acceptance.command; list the behavior the command verifies');
  const estimateValue =
    raw.estimate === undefined
      ? kind === 'verification'
        ? { lines: 1, files: 1 }
        : ordinaryDevProduct && !hasFrozenAcceptance
          ? { lines: 1500, files: 24 }
          : undefined
      : raw.estimate;
  if (estimateValue === undefined)
    throw new Error(
      'estimate is required for main/stabilize releases and frozen acceptance briefs; provide positive integer lines and files',
    );
  if (!estimateValue || typeof estimateValue !== 'object' || Array.isArray(estimateValue))
    throw new Error(
      'estimate must be an object with positive integer lines and files; ordinary dev product briefs may omit it',
    );
  const estimate = estimateValue as Record<string, unknown>;
  for (const key of ['lines', 'files'])
    if (!Number.isSafeInteger(estimate[key]) || (estimate[key] as number) < 1)
      throw new Error(`estimate.${key} must be a positive integer`);
  const continuationRequest = continuation(raw.continuation);
  const brief: Brief = {
    ...(continuationRequest ? { continuation: continuationRequest } : {}),
    goal,
    manager,
    kind,
    paths: list(raw.paths ?? (raw.kind === 'verification' ? [] : undefined), 'paths', raw.kind !== 'verification'),
    ...(raw.kind === 'verification' ? { proof: parseProofMetadata(raw.proof) } : {}),
    riskAreas: list(raw.riskAreas, 'riskAreas'),
    ...(target ? { target } : {}),
    ...(raw.model === undefined ? {} : { model: text(raw.model, 'model') }),
    ...(raw.effort === undefined ? {} : { effort: text(raw.effort, 'effort') }),
    acceptance: {
      command: commandMissing ? [] : list(acceptance.command, 'acceptance.command', true),
      tests: acceptance.tests === undefined ? [] : list(acceptance.tests, 'acceptance.tests', true),
      failing: boolean(acceptance.failing, 'acceptance.failing', workerOwnedAcceptance),
      ...(workerOwnedAcceptance ? { workerOwned: true as const } : {}),
      ...(placement === undefined ? {} : { placement: placement as AcceptancePlacement }),
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
  if (brief.kind === 'verification') {
    if (brief.paths.length || brief.riskAreas.length || brief.criticalPath || brief.target || placement === 'local')
      throw new Error(
        'verification is ordinary, read-only original acceptance; paths, risk areas, target and local override are forbidden',
      );
    if (hasFrozenAcceptance) throw new Error('verification cannot supply frozen input blocks');
  } else if (raw.proof !== undefined) throw new Error('proof metadata requires kind verification');
  if (brief.acceptance.placement === 'local') validateLocalAcceptanceCommand(brief.acceptance.command);
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

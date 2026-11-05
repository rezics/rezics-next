import { defaultPolicy, type ControlPolicy } from './policy.ts';
import { readFileSync } from 'node:fs';
import { isAbsolute, win32 } from 'node:path';
import type { AcceptancePlacement, AcceptanceRequirement, Brief, BriefContinuation, TaskKind } from './types.ts';
import { parseBunTestCommand, parseEnvironmentPrefix } from './command-shape.ts';
import { parseProofMetadata } from './verification.ts';

export type RiskAreaDefinition = readonly string[] | { include: readonly string[]; exclude?: readonly string[] };
export type RiskAreaRules = { area: string; include: readonly string[]; exclude: readonly string[] };
export type RiskOwnership = { version: number; areas: Record<string, RiskAreaDefinition> };
/** Prompt size diagnostic threshold. Large prompts still reach the provider and may meet the OS argument limit. */
export const MAX_BRIEF_BYTES = defaultPolicy.brief.bytes;
export const BRIEF_AUTHORITY_HINT = 'link an owner document section or quote the decision in the brief';
export const SUPERSEDED_CHECK_HINT = 'remove superseded check instructions from the brief';
const ACCEPTANCE_REQUIREMENTS: readonly AcceptanceRequirement[] = ['browser', 'native', 'root'];

export function supersededCheckInstructionParagraph(markdown: string): boolean {
  return markdown
    .split(/\n\s*\n/)
    .some(
      (section) =>
        /\b(?:saved|historical|previous|older)\b/i.test(section) &&
        /\b(?:prompt|instructions?|manifest|session)\b/i.test(section) &&
        /(?:worker-check|--wait)/i.test(section),
    );
}

export function assertBriefDispatchable(
  markdown: string,
  mainCheckout?: string,
  byteBudget = MAX_BRIEF_BYTES,
): string[] {
  const warnings: string[] = [];
  if (markdown.includes('.temp/goal/')) warnings.push(`references .temp/goal/; ${BRIEF_AUTHORITY_HINT}`);
  if (mainCheckout && markdown.includes(mainCheckout))
    warnings.push(`references the main checkout path; ${BRIEF_AUTHORITY_HINT}`);
  if (supersededCheckInstructionParagraph(markdown))
    warnings.push(`contains superseded check instructions; ${SUPERSEDED_CHECK_HINT}`);
  const bytes = Buffer.byteLength(markdown, 'utf8');
  if (bytes > byteBudget) warnings.push(`brief is ${bytes} bytes; diagnostic budget is ${byteBudget} bytes`);
  return warnings;
}

function pathImpliesStories(path: string): boolean {
  return /(?:^|\/)stories(?:\/|$)/i.test(path) || /\.stories\.[^./]+$/i.test(path);
}

export function acceptanceRequirements(
  brief: Pick<Brief, 'kind' | 'paths' | 'acceptance'> | Partial<Brief>,
): AcceptanceRequirement[] {
  const required = new Set<AcceptanceRequirement>(brief.acceptance?.requires ?? []);
  if (brief.kind === 'interface' || (brief.paths ?? []).some(pathImpliesStories)) required.add('browser');
  return [...required];
}
/** Visited (i, j) cells; wildcard products larger than this stall dispatch. */
type BriefPolicy = ControlPolicy['brief'];
function pathMatchExceeded(): never {
  throw new Error('path pattern matching exceeded the supported bound; shorten wildcards or split the pattern');
}
/** Deliberately small path language: literals, *, ?, and whole-segment **. */
export function validatePath(pattern: string, policy: BriefPolicy = defaultPolicy.brief): void {
  if (pattern.length > policy.pathCharacters)
    throw new Error(
      `declared path is ${pattern.length} characters; keep each pattern under ${policy.pathCharacters} characters`,
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
  policy: BriefPolicy,
): boolean {
  const width = lengthB + 1;
  const seen = new Set<number>();
  const stack = [0];
  while (stack.length) {
    const encoded = stack.pop()!;
    if (seen.has(encoded)) continue;
    seen.add(encoded);
    if (seen.size > policy.pathMatchStates) pathMatchExceeded();
    const i = Math.floor(encoded / width);
    const j = encoded - i * width;
    if (i === lengthA && j === lengthB) return true;
    expand(i, j, (ni, nj) => stack.push(ni * width + nj));
  }
  return false;
}
function segmentOverlap(a: string, b: string, policy: BriefPolicy): boolean {
  return overlapReachable(
    a.length,
    b.length,
    (i, j, push) => {
      const x = a[i],
        y = b[j];
      if (x === '*') push(i + 1, j);
      if (y === '*') push(i, j + 1);
      if (x === undefined || y === undefined) return;
      if (x === '*' || x === '?' || y === '*' || y === '?' || x === y)
        push(x === '*' ? i : i + 1, y === '*' ? j : j + 1);
    },
    policy,
  );
}
/** Intersect the glob languages rather than testing a glob string as though it were a filename. */
export function pathsOverlap(a: string, b: string, policy: BriefPolicy = defaultPolicy.brief): boolean {
  const left = a.split('/'),
    right = b.split('/');
  return overlapReachable(
    left.length,
    right.length,
    (i, j, push) => {
      const x = left[i],
        y = right[j];
      if (x === '**') push(i + 1, j);
      if (y === '**') push(i, j + 1);
      if (x === undefined || y === undefined) return;
      if (x === '**' || y === '**' || segmentOverlap(x, y, policy))
        push(x === '**' ? i : i + 1, y === '**' ? j : j + 1);
    },
    policy,
  );
}
export function matchesPath(
  path: string,
  patterns: readonly string[],
  policy: BriefPolicy = defaultPolicy.brief,
): boolean {
  // A concrete path is a literal pattern; reject metacharacters to avoid granting extra scope.
  if (/[*?]/.test(path)) return false;
  return patterns.some((pattern) => pathsOverlap(path, pattern, policy));
}

function validateRiskPatterns(value: unknown, label: string, policy: BriefPolicy): string[] {
  if (!Array.isArray(value) || value.some((pattern) => typeof pattern !== 'string'))
    throw new Error(`${label} must be a string list`);
  (value as unknown[]).forEach((pattern) => validatePath(pattern as string, policy));
  return value as string[];
}

function isRiskAreaRule(
  definition: RiskAreaDefinition,
): definition is { include: readonly string[]; exclude?: readonly string[] } {
  return !Array.isArray(definition);
}

function riskAreaRules(area: string, definition: RiskAreaDefinition): RiskAreaRules {
  if (!isRiskAreaRule(definition)) return { area, include: definition, exclude: [] };
  return { area, include: definition.include, exclude: definition.exclude ?? [] };
}

export function riskAreaRulesFor(ownership: RiskOwnership): RiskAreaRules[] {
  return Object.entries(ownership.areas).map(([area, definition]) => riskAreaRules(area, definition));
}

/** A protected-area snapshot retains each area's exclusions and keeps overlapping areas independent. */
export function protectedRiskAreasForBrief(
  ownership: RiskOwnership,
  declaredAreas: readonly string[],
): RiskAreaRules[] {
  const declared = new Set(declaredAreas);
  return riskAreaRulesFor(ownership).filter(({ area }) => !declared.has(area));
}

function patternCoveredByExclusion(pathPattern: string, exclusions: readonly string[]): boolean {
  return exclusions.some((exclusion) => {
    if (pathPattern === exclusion) return true;
    // Directory exclusions cover narrower claims rooted below that literal directory. A broader glob that may
    // include protected siblings remains classified as risk-bearing.
    if (!exclusion.endsWith('/**')) return false;
    const directory = exclusion.slice(0, -3);
    return pathPattern === directory || pathPattern.startsWith(`${directory}/`);
  });
}

/** Classify concrete files at landing, or declared glob patterns at brief admission. */
export function classifyRiskAreas(
  path: string,
  areas: readonly RiskAreaRules[],
  kind: 'file' | 'pattern',
  policy: BriefPolicy = defaultPolicy.brief,
): string[] {
  return areas
    .filter((area) => {
      const intersects = area.include.some((pattern) =>
        kind === 'file' ? matchesPath(path, [pattern], policy) : pathsOverlap(path, pattern, policy),
      );
      if (!intersects) return false;
      return kind === 'file'
        ? !matchesPath(path, area.exclude, policy)
        : !patternCoveredByExclusion(path, area.exclude);
    })
    .map(({ area }) => area);
}

/** Legacy flat protected paths remain effective alongside the per-area snapshot on new landing requests. */
export function isProtectedRiskPath(
  path: string,
  protectedPaths: readonly string[] = [],
  protectedAreas: readonly RiskAreaRules[] = [],
  policy: BriefPolicy = defaultPolicy.brief,
): boolean {
  return (
    matchesPath(path, protectedPaths, policy) || classifyRiskAreas(path, protectedAreas, 'file', policy).length > 0
  );
}

export function readRiskOwnership(file: string, policy: BriefPolicy = defaultPolicy.brief): RiskOwnership {
  const value = JSON.parse(readFileSync(file, 'utf8')) as RiskOwnership;
  if (value.version !== 1 || !value.areas || typeof value.areas !== 'object' || Array.isArray(value.areas))
    throw new Error('invalid risk ownership table');
  for (const [area, definition] of Object.entries(value.areas)) {
    if (Array.isArray(definition)) {
      validateRiskPatterns(definition, `risk ownership ${area} patterns`, policy);
      continue;
    }
    if (!definition || typeof definition !== 'object') throw new Error(`risk ownership ${area} must be an object`);
    const value = definition as { include?: unknown; exclude?: unknown };
    if (Object.keys(definition).some((key) => !['include', 'exclude'].includes(key)) || value.include === undefined)
      throw new Error(`risk ownership ${area} must declare include and optional exclude patterns`);
    validateRiskPatterns(value.include, `risk ownership ${area} include`, policy);
    if (value.exclude !== undefined) validateRiskPatterns(value.exclude, `risk ownership ${area} exclude`, policy);
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
const RESEARCHER_MODEL = /^(?:gpt|claude)-[a-z0-9.-]+$/;
function researcherModels(value: unknown, kind: unknown, model: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (kind !== 'research') throw new Error('researchers is only supported on research briefs');
  if (model !== undefined) throw new Error('research briefs cannot combine model and researchers');
  const models = list(value, 'researchers', true);
  if (models.some((candidate) => !RESEARCHER_MODEL.test(candidate)))
    throw new Error('researchers entries must be gpt-* or claude-* model pins');
  if (new Set(models).size !== models.length) throw new Error('researchers entries must be unique');
  return models;
}

export type ResearchFanoutBrief = {
  goal: string;
  manager: string;
  researchers: string[];
  paths: string[];
  groupId?: string;
};

/** Read and validate the backlog-only fan-out fields before creating one task per model. */
export function readResearchFanout(markdown: string): ResearchFanoutBrief | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) throw new Error('brief needs Markdown front matter');
  const raw = object(Bun.YAML.parse(match[1]!), 'front matter');
  const researchers = researcherModels(raw.researchers, raw.kind, raw.model);
  if (!researchers) return undefined;
  const groupId = raw.researchGroup === undefined ? undefined : text(raw.researchGroup, 'researchGroup');
  if (groupId && !/^[A-Za-z0-9_-]{1,128}$/.test(groupId)) throw new Error('researchGroup must be a valid identifier');
  return {
    goal: text(raw.goal, 'goal'),
    manager: text(raw.manager ?? raw.goal, 'manager'),
    researchers,
    paths: list(raw.paths ?? [], 'paths'),
    ...(groupId ? { groupId } : {}),
  };
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
  const parsed = parseBunTestCommand(argv);
  if (!parsed || parsed.prefix.length !== 2) return false;
  let files = 0;
  for (const argument of parsed.arguments) {
    if (argument.kind === 'option') {
      if (argument.flag !== '-t' && argument.flag !== '--test-name-pattern') return false;
      continue;
    }
    const value = argument.value;
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
  let changed = false;
  const seen = new Set<string>();
  const parsed = parseEnvironmentPrefix(argv);
  for (const operation of parsed.operations) {
    if (operation.kind === 'unset') {
      if (operation.name !== 'KERNEL_ORIGIN' || seen.has('KERNEL_ORIGIN')) return undefined;
      seen.add(operation.name);
      changed = true;
      continue;
    }
    if (operation.name === 'PUBLIC_ORIGIN' && operation.value === 'http://127.0.0.1:3000') {
      if (seen.has(operation.name)) return undefined;
      seen.add(operation.name);
      changed = true;
      continue;
    }
    return undefined;
  }
  return changed && parsed.command.length ? parsed.command : undefined;
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
export function parseBrief(
  markdown: string,
  ownership: RiskOwnership,
  policy: BriefPolicy = defaultPolicy.brief,
): Brief {
  const lintWarnings = assertBriefDispatchable(markdown, undefined, policy.bytes);
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
  const researchers = researcherModels(raw.researchers, kind, raw.model);
  const researchGroup = raw.researchGroup === undefined ? undefined : text(raw.researchGroup, 'researchGroup');
  const researchReport = raw.researchReport === undefined ? undefined : text(raw.researchReport, 'researchReport');
  if (researchGroup !== undefined && kind !== 'research')
    throw new Error('researchGroup is only valid on research briefs');
  if (researchGroup !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(researchGroup))
    throw new Error('researchGroup must be a valid identifier');
  if (researchReport !== undefined) {
    if (kind !== 'research' || !researchReport.startsWith('docs/research/') || !researchReport.endsWith('.md'))
      throw new Error('researchReport must be a docs/research/*.md path on a research brief');
    validatePath(researchReport, policy);
  }
  const hasFrozenAcceptance = /^\s*(?:`{3,}|~{3,})(?:[^\r\n]*[ \t])?path=/m.test(markdown);
  const ordinaryDevProduct = devProductBrief({ goal, kind, ...(target ? { target } : {}) });
  const acceptance: Record<string, unknown> = raw.acceptance === undefined ? {} : object(raw.acceptance, 'acceptance');
  const commandMissing = acceptance.command === undefined;
  const workerOwnedAcceptance = ordinaryDevProduct && !hasFrozenAcceptance && commandMissing;
  const placement = acceptance.placement;
  if (placement !== undefined && placement !== 'local' && placement !== 'default')
    throw new Error('acceptance.placement must be local or default');
  const requires =
    acceptance.requires === undefined
      ? undefined
      : list(acceptance.requires, 'acceptance.requires').map((item) => {
          if (!ACCEPTANCE_REQUIREMENTS.includes(item as AcceptanceRequirement))
            throw new Error('acceptance.requires must be a list of browser, native and root');
          return item as AcceptanceRequirement;
        });
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
    ...(lintWarnings.length ? { lintWarnings } : {}),
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
    ...(researchers ? { researchers } : {}),
    ...(researchGroup ? { researchGroup } : {}),
    ...(researchReport ? { researchReport } : {}),
    acceptance: {
      command: commandMissing ? [] : list(acceptance.command, 'acceptance.command', true),
      tests: acceptance.tests === undefined ? [] : list(acceptance.tests, 'acceptance.tests', true),
      failing: boolean(acceptance.failing, 'acceptance.failing', workerOwnedAcceptance),
      ...(workerOwnedAcceptance ? { workerOwned: true as const } : {}),
      ...(placement === undefined ? {} : { placement: placement as AcceptancePlacement }),
      ...(requires === undefined ? {} : { requires }),
    },
    estimate: { lines: estimate.lines as number, files: estimate.files as number },
    ...(raw.urgent === undefined ? {} : { urgent: boolean(raw.urgent, 'urgent') }),
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
  brief.paths.forEach((pattern) => validatePath(pattern, policy));
  if (brief.researchReport && !brief.paths.includes(brief.researchReport))
    throw new Error('researchReport must also be declared in paths');
  for (const area of brief.riskAreas)
    if (!Object.hasOwn(ownership.areas, area)) throw new Error(`unknown risk area: ${area}`);
  const riskRules = riskAreaRulesFor(ownership);
  const touchedAreas = new Set(brief.paths.flatMap((path) => classifyRiskAreas(path, riskRules, 'pattern', policy)));
  for (const area of touchedAreas) {
    if (!brief.riskAreas.includes(area)) throw new Error(`declared paths touch undeclared risk area: ${area}`);
  }
  return brief;
}

export const PRODUCT_SIZE_EXEMPT_KINDS: ReadonlySet<TaskKind> = new Set(['research', 'mechanical', 'specification']);

export type BriefSizeSnapshot = {
  goal: string;
  manager: string;
  kind?: TaskKind;
  target?: 'stabilize' | 'main';
  urgent: boolean;
  continuation: boolean;
  paths: string[];
  estimateLines?: number;
  bodyCharacters: number;
};

export type ProductBriefSizeViolation = {
  estimateLines?: number;
  bodyCharacters?: number;
};

/** Front matter and body size of a backlog file. Invalid YAML is untrusted input and is not a size return. */
export function readBriefSizeSnapshot(markdown: string): BriefSizeSnapshot | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) return;
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(match[1]!);
  } catch {
    return;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const value = raw as Record<string, unknown>;
  if (typeof value.goal !== 'string' || !value.goal.trim()) return;
  const goal = value.goal.trim();
  const manager = typeof value.manager === 'string' && value.manager.trim() ? value.manager.trim() : goal;
  const kind = BRIEF_KINDS.includes(value.kind as TaskKind) ? (value.kind as TaskKind) : undefined;
  const target = value.target === 'stabilize' || value.target === 'main' ? value.target : undefined;
  const paths = Array.isArray(value.paths)
    ? value.paths.filter((path): path is string => typeof path === 'string' && path.trim() !== '')
    : [];
  const estimate =
    value.estimate && typeof value.estimate === 'object' && !Array.isArray(value.estimate)
      ? (value.estimate as Record<string, unknown>).lines
      : undefined;
  const estimateLines =
    typeof estimate === 'number' && Number.isSafeInteger(estimate) && estimate >= 1 ? estimate : undefined;
  return {
    goal,
    manager,
    ...(kind ? { kind } : {}),
    ...(target ? { target } : {}),
    urgent: value.urgent === true,
    continuation: value.continuation !== undefined,
    paths,
    ...(estimateLines === undefined ? {} : { estimateLines }),
    bodyCharacters: markdown.slice(match[0].length).length,
  };
}

function sharedPathPrefix(left: string, right: string): number {
  const a = left.split('/');
  const b = right.split('/');
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

/** Declared-path closeness: shared directory prefix, with a glob-overlap bonus. */
export function briefPathCloseness(
  left: readonly string[],
  right: readonly string[],
  policy: BriefPolicy = defaultPolicy.brief,
): number {
  let best = 0;
  for (const a of left) {
    for (const b of right) {
      const score = sharedPathPrefix(a, b) + (pathsOverlap(a, b, policy) ? 1 : 0);
      if (score > best) best = score;
    }
  }
  return best;
}

/**
 * A product brief below `brief.minimumEstimateLines` or over `brief.maximumBodyCharacters`.
 * Urgent, research, mechanical, specification and continuation briefs are exempt; omitted estimates use 1,500 lines.
 */
export function productBriefSizeViolation(
  markdown: string,
  policy: BriefPolicy = defaultPolicy.brief,
  fileName?: string,
): ProductBriefSizeViolation | undefined {
  if (fileName?.startsWith('continuation-')) return;
  const snapshot = readBriefSizeSnapshot(markdown);
  if (!snapshot?.kind || snapshot.urgent || snapshot.continuation) return;
  if (PRODUCT_SIZE_EXEMPT_KINDS.has(snapshot.kind)) return;
  if (
    !devProductBrief({
      goal: snapshot.goal,
      kind: snapshot.kind,
      ...(snapshot.target ? { target: snapshot.target } : {}),
    })
  )
    return;
  const frozen = /^\s*(?:`{3,}|~{3,})(?:[^\r\n]*[ \t])?path=/m.test(markdown);
  const lines = snapshot.estimateLines ?? (frozen ? undefined : 1500);
  const estimateLines = lines !== undefined && lines < policy.minimumEstimateLines ? lines : undefined;
  const bodyCharacters = snapshot.bodyCharacters > policy.maximumBodyCharacters ? snapshot.bodyCharacters : undefined;
  if (estimateLines === undefined && bodyCharacters === undefined) return;
  return {
    ...(estimateLines === undefined ? {} : { estimateLines }),
    ...(bodyCharacters === undefined ? {} : { bodyCharacters }),
  };
}

export function productBriefSizeReturnReason(
  violation: ProductBriefSizeViolation,
  policy: BriefPolicy = defaultPolicy.brief,
): string {
  const parts: string[] = [];
  if (violation.estimateLines !== undefined)
    parts.push(
      `estimate.lines is ${violation.estimateLines}; brief.minimumEstimateLines is ${policy.minimumEstimateLines}`,
    );
  if (violation.bodyCharacters !== undefined)
    parts.push(
      `body is ${violation.bodyCharacters} characters; brief.maximumBodyCharacters is ${policy.maximumBodyCharacters}`,
    );
  return `${parts.join('. ')}. Merge with related briefs of the same Goal and area into one outcome, or rewrite it.`;
}

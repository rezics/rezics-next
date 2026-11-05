import { matchesPath } from './briefs.ts';
import { resolveImportConflicts } from './import-conflicts.ts';
import { defaultPolicy } from './policy.ts';

export type DerivedFile = {
  path: string;
  stage: 'integration' | 'promotion';
  command: string[];
  /** Source paths whose changes should refresh this output when a dev landing is assembled. */
  inputs?: string[];
};

export function derivedForPath(
  path: string,
  files: readonly DerivedFile[],
  policy = defaultPolicy.brief,
): DerivedFile[] {
  return files.filter((file) => matchesPath(path, [file.path], policy));
}

export type CandidateConflictPlan = {
  mechanicalPaths: string[];
  derivedPaths: string[];
  commands: string[][];
};

/** Partition conflicted candidate paths and collapse repeated generator commands without touching the worktree. */
export function planCandidateConflicts(
  paths: readonly string[],
  files: readonly DerivedFile[],
  policy = defaultPolicy.brief,
): CandidateConflictPlan {
  const mechanicalPaths: string[] = [];
  const derivedPaths: string[] = [];
  const commands = new Map<string, string[]>();
  for (const path of paths) {
    const derived = derivedForPath(path, files, policy);
    if (!derived.length) {
      mechanicalPaths.push(path);
      continue;
    }
    derivedPaths.push(path);
    for (const file of derived) commands.set(JSON.stringify(file.command), [...file.command]);
  }
  return { mechanicalPaths, derivedPaths, commands: [...commands.values()] };
}

export type CandidateDelta =
  | { kind: 'already-present'; paths: string[] }
  | { kind: 'partial-no-effect'; paths: string[] }
  | { kind: 'effective' };

/** Describe which source changes the rebased candidate actually contributes to its current target. */
export function classifyCandidateDelta(
  taskPaths: readonly string[],
  taskChangedPaths: readonly string[],
  candidateChangedPaths: readonly string[],
): CandidateDelta {
  if (!candidateChangedPaths.length) return { kind: 'already-present', paths: [...taskPaths] };
  const taskChanged = new Set(taskChangedPaths);
  const candidateChanged = new Set(candidateChangedPaths);
  const noEffect = taskPaths.filter((path) => taskChanged.has(path) && !candidateChanged.has(path));
  return noEffect.length ? { kind: 'partial-no-effect', paths: noEffect } : { kind: 'effective' };
}

type JsonObject = Record<string, unknown>;
type JsonMergeResult = { ok: true; value: JsonObject } | { ok: false; key: string };

function parseFlatJsonObject(text: string): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return value as JsonObject;
  } catch {
    return undefined;
  }
}

function comparableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(comparableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value as JsonObject)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${comparableJson((value as JsonObject)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Three-way merge flat message catalogs, retaining ours' catalog order and appending theirs' new keys. */
function mergeFlatJsonMessage(baseText: string, oursText: string, theirsText: string): JsonMergeResult {
  const base = parseFlatJsonObject(baseText);
  const ours = parseFlatJsonObject(oursText);
  const theirs = parseFlatJsonObject(theirsText);
  if (!base || !ours || !theirs) return { ok: false, key: '<invalid JSON catalog>' };
  const absent = Symbol('absent');
  const equal = (left: unknown | typeof absent, right: unknown | typeof absent) =>
    left === absent || right === absent ? left === right : comparableJson(left) === comparableJson(right);
  const keys = [...Object.keys(ours), ...Object.keys(theirs).filter((key) => !(key in ours))];
  const value: JsonObject = {};
  for (const key of keys) {
    const b = Object.hasOwn(base, key) ? base[key] : absent;
    const o = Object.hasOwn(ours, key) ? ours[key] : absent;
    const t = Object.hasOwn(theirs, key) ? theirs[key] : absent;
    const chosen = equal(o, t) ? o : equal(o, b) ? t : equal(t, b) ? o : undefined;
    if (chosen === undefined && !equal(o, b) && !equal(t, b)) return { ok: false, key };
    if (chosen !== absent && chosen !== undefined) value[key] = chosen;
  }
  return { ok: true, value };
}

export type CandidateTextConflictResolution =
  | { ok: true; text: string; taskChangeDropped: boolean }
  | { ok: false; reason: string }
  | undefined;

/** Resolve only the conflict forms that have a deterministic file-content merge. */
export function resolveCandidateTextConflict(
  path: string,
  currentText: string,
  stages: readonly [string, string, string] | undefined,
  jsonMessage: boolean,
): CandidateTextConflictResolution {
  if (jsonMessage) {
    if (!stages) return { ok: false, reason: `Cannot read JSON conflict stages for ${path}` };
    const merged = mergeFlatJsonMessage(stages[0], stages[1], stages[2]);
    if (!merged.ok) return { ok: false, reason: `JSON message conflict in ${path}: key ${merged.key}` };
    const ours = parseFlatJsonObject(stages[1]);
    const theirs = parseFlatJsonObject(stages[2]);
    const base = parseFlatJsonObject(stages[0]);
    const taskChangeDropped = Boolean(
      ours &&
        theirs &&
        base &&
        comparableJson(merged.value) === comparableJson(ours) &&
        comparableJson(theirs) !== comparableJson(ours) &&
        comparableJson(theirs) !== comparableJson(base),
    );
    return {
      ok: true,
      text: `${JSON.stringify(merged.value, null, 2)}\n`,
      taskChangeDropped,
    };
  }
  if (!/\.[cm]?[jt]sx?$/.test(path)) return undefined;
  const text = resolveImportConflicts(currentText);
  return text === undefined ? undefined : { ok: true, text, taskChangeDropped: false };
}

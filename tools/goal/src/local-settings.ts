import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/** `note` and `$comment` annotate any object in the local settings; they are removed before validation. */
export function withoutAnnotations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAnnotations);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'note' && key !== '$comment')
      .map(([key, item]) => [key, withoutAnnotations(item)]),
  );
}

/** The local settings document without annotations; `{}` when the file does not exist. */
export function readLocalFile(file: string): unknown {
  return existsSync(file) ? withoutAnnotations(JSON.parse(readFileSync(file, 'utf8'))) : {};
}

export type ConfigurationProblem = {
  file: string;
  error: string;
  reported: boolean;
  snapshot: string;
  key: string;
  token: string;
};
type Snapshot = { file: string; local: unknown; reported?: string; problem?: string; problemToken?: string };

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const problems = new WeakMap<object, ConfigurationProblem>();

/** Resolve aliases in the existing path prefix too, so a missing settings file retains its canonical identity. */
function canonicalFile(file: string, aliases = new Set<string>()): string {
  const absolute = resolve(file);
  try {
    return realpathSync(absolute);
  } catch {
    /* the file may be missing or a dangling symlink */
  }
  if (!aliases.has(absolute)) {
    try {
      if (lstatSync(absolute).isSymbolicLink()) {
        const target = readlinkSync(absolute);
        const resolved = isAbsolute(target) ? target : resolve(dirname(absolute), target);
        const nextAliases = new Set(aliases);
        nextAliases.add(absolute);
        return canonicalFile(resolved, nextAliases);
      }
    } catch {
      /* not a readable symlink; resolve the existing parent below */
    }
  }
  const missing: string[] = [];
  let ancestor = absolute;
  while (true) {
    try {
      return join(realpathSync(ancestor), ...missing);
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) return absolute;
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}
/** One snapshot per canonical local file, so another checkout's or file's settings are never substituted. */
function snapshotPath(identity: string, initialMain: string): string {
  return join(initialMain, '.temp/goal/configuration', `${sha(identity)}.json`);
}
function readSnapshot(path: string, identity: string): Snapshot | undefined {
  try {
    const snapshot = JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
    return (
      typeof snapshot.file === 'string' &&
      snapshot.local !== undefined &&
      (snapshot.file === identity || canonicalFile(snapshot.file) === identity)
    )
      ? snapshot
      : undefined;
  } catch {
    return undefined;
  }
}
function writeSnapshot(path: string, snapshot: Snapshot): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, JSON.stringify(snapshot), { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    // The snapshot only improves recovery from a later invalid edit; failing to write it changes nothing now.
    rmSync(temporary, { force: true });
  }
}

/**
 * Validate the live local file. A valid file becomes the file's last-valid snapshot; an invalid one falls back to that
 * snapshot, revalidated with the current schema and environment, and the returned settings carry the problem for
 * `configurationProblem`. Without a usable snapshot the original error is thrown.
 */
export function loadLocalSettings<T extends object>(
  file: string,
  initialMain: string,
  validate: (local: unknown) => T,
): T {
  const identity = canonicalFile(file);
  const path = snapshotPath(identity, initialMain);
  let text = '';
  try {
    text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const local = text ? withoutAnnotations(JSON.parse(text)) : {};
    const settings = validate(local);
    const previous = readSnapshot(path, identity);
    // An accepted empty or missing file is a clear; valid settings also reset invalid-edit reporting.
    if (
      previous?.file !== identity ||
      previous?.problem !== undefined ||
      previous?.problemToken !== undefined ||
      previous?.reported !== undefined ||
      JSON.stringify(previous?.local) !== JSON.stringify(local)
    )
      writeSnapshot(path, { file: identity, local });
    return settings;
  } catch (error) {
    let snapshot = readSnapshot(path, identity);
    if (!snapshot) throw error;
    let settings: T;
    try {
      settings = validate(snapshot.local);
    } catch {
      throw error;
    }
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300);
    const key = sha(`${text}\0${message}`);
    const sameProblem = snapshot.problem === key && snapshot.problemToken !== undefined;
    const legacyReported = snapshot.problem === undefined && snapshot.reported === key;
    const token = sameProblem ? snapshot.problemToken! : randomUUID();
    if (!sameProblem) {
      const next: Snapshot = { ...snapshot, file: identity, problem: key, problemToken: token };
      if (!legacyReported) delete next.reported;
      snapshot = next;
      writeSnapshot(path, snapshot);
    }
    problems.set(settings, {
      file,
      error: message,
      reported: snapshot.reported === key,
      snapshot: path,
      key,
      token,
    });
    return settings;
  }
}

/** The invalid live file behind settings that came from its last-valid snapshot. */
export function configurationProblem(settings: object): ConfigurationProblem | undefined {
  return problems.get(settings);
}
/** Record that this invalid version was reported, so later processes do not report it again. */
export function reportedConfigurationProblem(problem: ConfigurationProblem): void {
  const snapshot = readSnapshot(problem.snapshot, canonicalFile(problem.file));
  if (snapshot?.problem === problem.key && snapshot.problemToken === problem.token && snapshot.reported !== problem.key)
    writeSnapshot(problem.snapshot, { ...snapshot, reported: problem.key });
}

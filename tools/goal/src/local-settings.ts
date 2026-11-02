import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

export type ConfigurationProblem = { file: string; error: string; reported: boolean; snapshot: string; key: string };
type Snapshot = { file: string; local: unknown; reported?: string };

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const problems = new WeakMap<object, ConfigurationProblem>();

/** One snapshot per canonical local file, so another checkout's or file's settings are never substituted. */
function snapshotPath(file: string, initialMain: string): string {
  let canonical = file;
  try {
    canonical = realpathSync(file);
  } catch {
    /* a missing file keeps its resolved path */
  }
  return join(initialMain, '.temp/goal/configuration', `${sha(canonical)}.json`);
}
function readSnapshot(path: string, file: string): Snapshot | undefined {
  try {
    const snapshot = JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
    return snapshot.file === file && snapshot.local !== undefined ? snapshot : undefined;
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
  const path = snapshotPath(file, initialMain);
  let text = '';
  try {
    text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const local = text ? withoutAnnotations(JSON.parse(text)) : {};
    const settings = validate(local);
    if (text) {
      const previous = readSnapshot(path, file);
      // A valid file also clears the reported marker, so the next invalid edit is reported again.
      if (previous?.reported !== undefined || JSON.stringify(previous?.local) !== JSON.stringify(local))
        writeSnapshot(path, { file, local });
    }
    return settings;
  } catch (error) {
    const snapshot = readSnapshot(path, file);
    if (!snapshot) throw error;
    let settings: T;
    try {
      settings = validate(snapshot.local);
    } catch {
      throw error;
    }
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300);
    const key = sha(`${text}\0${message}`);
    problems.set(settings, { file, error: message, reported: snapshot.reported === key, snapshot: path, key });
    return settings;
  }
}

/** The invalid live file behind settings that came from its last-valid snapshot. */
export function configurationProblem(settings: object): ConfigurationProblem | undefined {
  return problems.get(settings);
}
/** Record that this invalid version was reported, so later processes do not report it again. */
export function reportedConfigurationProblem(problem: ConfigurationProblem): void {
  const snapshot = readSnapshot(problem.snapshot, problem.file);
  if (snapshot) writeSnapshot(problem.snapshot, { ...snapshot, reported: problem.key });
}

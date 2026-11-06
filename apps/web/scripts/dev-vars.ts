import { constants, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const app = resolve(import.meta.dir, '..');

/** Prepare committed development values without replacing local configuration. */
export function ensureLocalWorkerVars(directory = app): void {
  const destination = join(directory, '.dev.vars');
  if (existsSync(destination)) return;
  try {
    copyFileSync(join(directory, '.dev.vars.example'), destination, constants.COPYFILE_EXCL);
  } catch (error) {
    // Another runner may have created the file after the existence check.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/** Committed development bindings for a test Vite process. Does not write `.dev.vars`. */
export function readExampleWorkerVars(directory = app): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of readFileSync(join(directory, '.dev.vars.example'), 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    vars[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return vars;
}

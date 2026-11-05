import { constants, copyFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Prepare committed development values without replacing local configuration. */
export function ensureLocalWorkerVars(directory = resolve(import.meta.dir, '..')): void {
  const destination = join(directory, '.dev.vars');
  if (existsSync(destination)) return;
  try {
    copyFileSync(join(directory, '.dev.vars.example'), destination, constants.COPYFILE_EXCL);
  } catch (error) {
    // Another runner may have created the file after the existence check.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

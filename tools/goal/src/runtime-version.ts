import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { git } from './merge.ts';

const execFileAsync = promisify(execFile);

/** Return the Git object id for a path in the control plane currently published on main. */
export function codeVersion(mainCheckout: string, path: string): string {
  return git(mainCheckout, 'rev-parse', '--verify', `main:${path}`);
}

/** Snapshot the published tools/goal object id. Call once at process start; do not re-read after refs move. */
export function captureLoadedCodeVersion(mainCheckout: string): string {
  return codeVersion(mainCheckout, 'tools/goal');
}

/**
 * The published tools/goal object id, read without blocking the caller's event loop. A failed read is undefined: a
 * long-lived host polls this, and a transient Git error must never be taken for a new revision.
 */
export async function currentCodeVersion(mainCheckout: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', 'main:tools/goal'], { cwd: mainCheckout });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

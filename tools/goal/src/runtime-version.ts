import { git } from './merge.ts';

/** Return the Git object id for a path in the control plane currently published on main. */
export function codeVersion(mainCheckout: string, path: string): string {
  return git(mainCheckout, 'rev-parse', '--verify', `main:${path}`);
}

/** Snapshot the published tools/goal object id. Call once at process start; do not re-read after refs move. */
export function captureLoadedCodeVersion(mainCheckout: string): string {
  return codeVersion(mainCheckout, 'tools/goal');
}

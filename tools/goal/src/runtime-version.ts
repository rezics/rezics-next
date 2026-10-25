import { git } from './merge.ts';

/** Return the Git object id for a path in the control plane currently checked out on main. */
export function codeVersion(mainCheckout: string, path: string): string {
  return git(mainCheckout, 'rev-parse', '--verify', `main:${path}`);
}

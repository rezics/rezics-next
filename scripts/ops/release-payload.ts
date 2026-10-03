import { cpSync } from 'node:fs';
import { relative, sep } from 'node:path';

/** Workspace links in node_modules must not pull live dev state into a release digest. */
export function copyReleaseTree(source: string, destination: string): void {
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    // Evaluate from the copied root: the checkout itself may live under .temp.
    filter: (path) =>
      relative(source, path)
        .split(sep)
        .every((segment) => segment !== '.cache' && segment !== '.wrangler'),
  });
}

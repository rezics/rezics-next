// Runs the pinned ast-grep binary. Yarn build scripts are disabled here, so the
// package's postinstall never replaces its Node fallback shim, which prints a
// warning and spawns an extra process on every call; resolve the native binary directly.
import { createRequire } from 'node:module';

const { resolveBinaryPath } = createRequire(import.meta.url)('@ast-grep/cli/postinstall.js') as {
  resolveBinaryPath(): string | null;
};
const binary = resolveBinaryPath();
if (!binary)
  throw new Error(
    'The pinned @ast-grep/cli native binary is not installed; run yarn install --immutable',
  );
const child = Bun.spawn([binary, ...process.argv.slice(2)], {
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exit(await child.exited);

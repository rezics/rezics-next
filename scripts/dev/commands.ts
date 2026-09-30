// Direct entry points for root commands that scripts and tests invoke as child
// processes. Task is the human and agent facade; code calls the scripts directly
// so it depends on neither Task nor Yarn at runtime.
const entries: Record<string, string[]> = {
  'ops:backup': ['scripts/ops/backup.ts'],
  'ops:restore': ['scripts/ops/restore.ts'],
  'stack:up': ['scripts/dev/cli.ts', 'stack:up'],
  'stack:down': ['scripts/dev/cli.ts', 'stack:down'],
  'stack:reset': ['scripts/dev/cli.ts', 'stack:reset'],
  'stack:logs': ['scripts/dev/cli.ts', 'stack:logs'],
  'stack:status': ['scripts/dev/cli.ts', 'stack:status'],
  'stack:backup': ['scripts/dev/cli.ts', 'stack:backup'],
  'stack:clone': ['scripts/dev/cli.ts', 'stack:clone'],
  'search:rebuild': ['scripts/operations/rebuild-content-search.ts'],
  'release:build': ['scripts/dev/release-artifact.ts', 'build'],
  'release:install': ['scripts/dev/release-artifact.ts', 'install'],
  'access:pending-search': ['services/main/src/private-search-pending.ts'],
};

/** Returns the Bun program and arguments for `[command, ...args]`. */
export function scriptCommand([name, ...args]: string[]): ['bun', string[]] {
  const entry = name ? entries[name] : undefined;
  if (!entry) throw new Error(`Unknown root command: ${name}`);
  return ['bun', [...entry, ...args]];
}

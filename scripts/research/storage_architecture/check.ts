// One root static gate: types, generated contracts, docs, lint, format, and imports.
const backend = process.argv.slice(2).includes('--backend');
if (process.argv.slice(2).some((arg) => arg !== '--backend')) {
  throw new Error('Unsupported check option');
}
const commands: string[][] = [
  ['bun', 'node_modules/typescript/bin/tsc', '--project', 'services/main/tsconfig.json'],
  ['bun', 'scripts/api/eden-gate.ts'],
  ['bun', 'node_modules/typescript/bin/tsc', '--project', 'services/account/tsconfig.json'],
  ['bun', 'node_modules/typescript/bin/tsc', '--project', 'services/content/tsconfig.json'],
  ['bun', 'node_modules/typescript/bin/tsc', '--project', 'packages/model/tsconfig.json'],
  ...(!backend
    ? [
        ['bun', 'node_modules/typescript/bin/tsc', '--project', 'packages/ui/tsconfig.json'],
        ['bun', 'node_modules/typescript/bin/tsc', '--project', 'apps/web/tsconfig.json'],
      ]
    : []),
  ['bun', 'node_modules/typescript/bin/tsc', '--project', 'scripts/load/tsconfig.json'],
  ['bun', 'node_modules/typescript/bin/tsc', '--project', 'scripts/goal/tsconfig.json'],
  [
    'bun',
    'node_modules/typescript/bin/tsc',
    '--project',
    'scripts/research/storage_architecture/tsconfig.json',
  ],
  ['yarn', 'gen:check'],
  ['yarn', 'docs:check'],
  [
    'node_modules/.bin/biome',
    'lint',
    ...(!backend ? ['apps'] : []),
    'services',
    ...(backend ? ['packages/model'] : ['packages']),
    'scripts/qa',
    'scripts/goal',
    'scripts/load',
    'scripts/api',
    'scripts/fixtures',
    'scripts/documentation',
    'scripts/operations',
    'scripts/research',
    'tests/qa',
    'tests/recovery',
  ],
  [
    'node_modules/.bin/biome',
    'format',
    'package.json',
    ...(!backend ? ['apps/web/package.json'] : []),
    'services/main/package.json',
    'services/account/package.json',
    'services/content/package.json',
    'packages/model/package.json',
    ...(!backend ? ['packages/ui/package.json'] : []),
    'biome.json',
    '.dependency-cruiser.json',
    'scripts/research/storage_architecture/check.ts',
    'tests/qa/unit/static-gates.test.ts',
  ],
];

for (const command of commands) {
  const child = Bun.spawn(command, { stdout: 'inherit', stderr: 'inherit' });
  if ((await child.exited) !== 0) process.exit(1);
}

const graph = Bun.spawnSync({
  cmd: [
    'node_modules/.bin/depcruise',
    '--config',
    '.dependency-cruiser.json',
    '--output-type',
    'err',
    ...(!backend
      ? ['apps/web/app', 'apps/web/features', 'apps/web/i18n', 'apps/web/worker', 'packages/ui/src']
      : []),
    'packages/model/src',
    'services/main/src',
    'services/account/src',
    'services/content/src',
  ],
  stdout: 'pipe',
  stderr: 'pipe',
});
const graphOutput = Buffer.from(graph.stdout).toString();
process.stdout.write(graphOutput);
process.stderr.write(Buffer.from(graph.stderr).toString());
if (
  graph.exitCode !== 0 ||
  !/\([1-9]\d* modules, [1-9]\d* dependencies cruised\)/.test(graphOutput)
) {
  console.error('Dependency graph gate failed or scanned no TypeScript dependencies');
  process.exit(1);
}
export {};

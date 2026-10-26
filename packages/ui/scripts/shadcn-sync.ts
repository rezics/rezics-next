import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const defaultRoot = join(import.meta.dir, '..');
const registryUrl = 'https://registry.npmjs.org/shadcn/latest';
const exactVersion = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;

type Manifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [key: string]: unknown;
};

type SyncOptions = {
  root?: string;
  now?: () => Date;
  fetch?: typeof globalThis.fetch;
  runCommand?: (
    command: string,
    args: string[],
    options: { cwd: string },
  ) => Promise<{ stdout: string; stderr?: string }>;
};

async function latestVersion(fetcher: typeof globalThis.fetch): Promise<string> {
  const response = await fetcher(registryUrl);
  if (!response.ok) throw new Error(`Could not read the latest shadcn version: ${response.status}`);
  const registry = (await response.json()) as { version?: unknown };
  if (typeof registry.version !== 'string' || !exactVersion.test(registry.version))
    throw new Error('The shadcn registry returned an invalid latest version');
  return registry.version;
}

async function run(command: string, args: string[], options: { cwd: string }): Promise<{ stdout: string }> {
  const child = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (exitCode !== 0) throw new Error(`${command} ${args.join(' ')} failed (${exitCode}): ${stderr || stdout}`);
  return { stdout };
}

function makePinsExact(manifest: Manifest): void {
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const dependencies = manifest[field];
    if (!dependencies) continue;
    for (const [name, value] of Object.entries(dependencies)) {
      if (value === 'workspace:*') continue;
      const version = value.replace(/^[~^]/, '');
      if (!exactVersion.test(version)) throw new Error(`${name} has a non-exact package version: ${value}`);
      dependencies[name] = version;
    }
  }
}

/** Re-adds the cloned component sources from shadcn@latest and records success only after installation succeeds. */
export async function syncShadcn(options: SyncOptions = {}): Promise<{ version: string; syncedAt: string }> {
  const packageRoot = options.root ?? defaultRoot;
  const repositoryRoot = resolve(packageRoot, '..', '..');
  const fetcher = options.fetch ?? globalThis.fetch;
  const runner = options.runCommand ?? run;
  const version = await latestVersion(fetcher);
  const componentDirectory = join(packageRoot, 'src', 'shadcn');
  const components = (await readdir(componentDirectory))
    .filter((file) => file.endsWith('.tsx'))
    .map((file) => file.slice(0, -'.tsx'.length))
    .sort();
  if (components.length === 0) throw new Error('No cloned shadcn components were found in src/shadcn');

  await runner('bunx', ['--bun', 'shadcn@latest', 'add', '--yes', '--overwrite', ...components], {
    cwd: packageRoot,
  });
  await runner('bun', ['scripts/shadcn-index.ts'], { cwd: packageRoot });

  const manifestPath = join(packageRoot, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
  if (!manifest.devDependencies) manifest.devDependencies = {};
  manifest.devDependencies.shadcn = version;
  makePinsExact(manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await runner('bun', ['install'], { cwd: repositoryRoot });

  const syncedAt = (options.now ?? (() => new Date()))().toISOString();
  await writeFile(join(packageRoot, 'shadcn-sync.json'), `${JSON.stringify({ syncedAt, version }, null, 2)}\n`);
  await runner('git', ['diff', '--'], { cwd: repositoryRoot });

  return { version, syncedAt };
}

if (import.meta.main) {
  const result = await syncShadcn();
  console.log(`Updated ${result.version} shadcn components at ${result.syncedAt}. Review the diff before committing.`);
}

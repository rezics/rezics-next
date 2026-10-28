import { resolve } from 'node:path';

type DeploymentOptions = {
  dryRun: boolean;
  build: () => Promise<void>;
  smoke: () => Promise<void>;
  wrangler: (args: string[]) => Promise<string>;
  print: (line: string) => void;
};

export async function runDeployment(options: DeploymentOptions): Promise<void> {
  await options.build();
  await options.smoke();
  const config = resolve(import.meta.dir, '../storybook.wrangler.jsonc');
  if (options.dryRun) {
    options.print(await options.wrangler(['versions', 'upload', '--config', config, '--dry-run']));
    return;
  }

  const uploaded = await options.wrangler(['versions', 'upload', '--config', config]);
  const version = uploaded.match(/Version ID:\s*([\w-]+)/i)?.[1] ?? uploaded.match(/version\s+([\w-]+)/i)?.[1];
  const preview = uploaded.match(/https:\/\/[^\s]+workers\.dev[^\s]*/i)?.[0];
  if (!version || !preview)
    throw new Error('Wrangler upload did not report the uploaded version ID and its preview URL.');
  await options.wrangler(['versions', 'deploy', `${version}@100`, '--config', config, '--yes']);
  options.print(`Published ${version}\nPreview: ${preview}`);
}

async function wrangler(args: string[]): Promise<string> {
  const app = resolve(import.meta.dir, '..');
  const child = Bun.spawn(['./node_modules/.bin/wrangler', ...args], {
    cwd: app,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (code !== 0) throw new Error(`wrangler ${args.join(' ')} failed with exit code ${code}`);
  return `${stdout}\n${stderr}`;
}

if (import.meta.main) {
  const app = resolve(import.meta.dir, '..');
  const run = (script: string[]) =>
    Bun.spawnSync(['bun', ...script], {
      cwd: app,
      env: process.env,
      stdout: 'inherit',
      stderr: 'inherit',
    });
  await runDeployment({
    dryRun: process.argv.includes('--dry-run'),
    build: async () => {
      const result = run(['scripts/storybook-build.ts']);
      if (result.exitCode !== 0) throw new Error(`Storybook build failed with exit code ${result.exitCode}`);
    },
    smoke: async () => {
      const result = run(['scripts/storybook-smoke.ts']);
      if (result.exitCode !== 0) throw new Error(`Storybook smoke test failed with exit code ${result.exitCode}`);
    },
    wrangler,
    print: (line) => console.log(line),
  });
}

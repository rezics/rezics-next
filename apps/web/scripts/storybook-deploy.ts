import { resolve } from 'node:path';

type DeploymentOptions = {
  dryRun: boolean;
  commit?: string;
  build: () => Promise<void>;
  smoke: () => Promise<void>;
  wrangler: (args: string[]) => Promise<string>;
  fetchBuild?: () => Promise<{ commit?: string }>;
  print: (line: string) => void;
};

export async function runDeployment(options: DeploymentOptions): Promise<void> {
  await options.build();
  await options.smoke();
  const config = resolve(import.meta.dir, '../storybook.wrangler.jsonc');
  const expectedCommit = options.commit;
  if (!options.dryRun && !expectedCommit)
    throw new Error('The built commit SHA is required to verify the live Storybook.');
  if (options.dryRun) {
    options.print(`Dry run: validate ${options.commit ?? 'the built commit'}; no version or domain changes.`);
    options.print(await options.wrangler(['deploy', '--dry-run', '--config', config]));
    return;
  }

  const uploaded = await options.wrangler(['versions', 'upload', '--config', config]);
  const version = uploaded.match(/Version ID:\s*([\w-]+)/i)?.[1] ?? uploaded.match(/version\s+([\w-]+)/i)?.[1];
  const preview = uploaded.match(/https:\/\/[^\s]+workers\.dev[^\s]*/i)?.[0];
  if (!version || !preview)
    throw new Error('Wrangler upload did not report the uploaded version ID and its preview URL.');
  await options.wrangler(['versions', 'deploy', `${version}@100`, '--config', config, '--yes']);
  await options.wrangler(['triggers', 'deploy', '--config', config]);
  const liveBuild = await (options.fetchBuild ?? fetchLiveBuild)();
  if (liveBuild.commit !== expectedCommit) {
    throw new Error(
      `Live build does not name the deployed commit ${expectedCommit} (found ${liveBuild.commit ?? 'none'}).`,
    );
  }
  options.print(`Published ${version}\nPreview: ${preview}`);
}

async function fetchLiveBuild(): Promise<{ commit?: string }> {
  const response = await fetch('https://storybook.rezics.com/build.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not verify the live Storybook build (${response.status}).`);
  return (await response.json()) as { commit?: string };
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
  const gitCommit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: resolve(app, '../..') });
  if (gitCommit.exitCode !== 0) throw new Error('Could not read the current Git commit SHA.');
  const commit = gitCommit.stdout.toString().trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Git did not return a full commit SHA.');
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
    commit,
    wrangler,
    fetchBuild: fetchLiveBuild,
    print: (line) => console.log(line),
  });
}

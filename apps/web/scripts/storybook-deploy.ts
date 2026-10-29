import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

type DeploymentOptions = {
  dryRun: boolean;
  force?: boolean;
  commit?: string;
  cloudflareOutputDir?: string;
  build: () => Promise<void>;
  smoke: () => Promise<void>;
  wrangler: (args: string[]) => Promise<string>;
  fetchBuild?: () => Promise<{ commit?: string }>;
  isTreeClean?: () => Promise<string[]>;
  print: (line: string) => void;
};

export async function runDeployment(options: DeploymentOptions): Promise<void> {
  const expectedCommit = options.commit;
  if (!options.dryRun && !expectedCommit)
    throw new Error('The built commit SHA is required to verify the live Storybook.');
  if (!options.dryRun) {
    const changedPaths = await (options.isTreeClean ?? getChangedPaths)();
    if (changedPaths.length > 0) {
      options.print(`Cannot publish from a dirty working tree:\n${changedPaths.join('\n')}`);
      throw new Error(`Cannot publish from a dirty working tree: ${changedPaths.join(', ')}`);
    }
    if (!options.force) {
      try {
        const liveBuild = await (options.fetchBuild ?? fetchLiveBuild)();
        if (liveBuild.commit === expectedCommit) {
          options.print(`Already published ${expectedCommit}`);
          return;
        }
      } catch {
        // A new or unavailable domain should not prevent the first deployment.
      }
    }
  }
  await options.build();
  await options.smoke();
  const cloudflareOutputDir = options.cloudflareOutputDir ?? resolve(import.meta.dir, '../.cloudflare/output');
  rmSync(cloudflareOutputDir, { recursive: true, force: true });
  options.print(`Removed leftover Cloudflare build output: ${cloudflareOutputDir}`);
  const config = resolve(import.meta.dir, '../storybook.wrangler.jsonc');
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

type StatusOptions = {
  localCommit: string;
  fetchBuild?: () => Promise<{ commit?: string }>;
  print: (line: string) => void;
};

export async function runStatus(options: StatusOptions): Promise<0 | 2 | 3> {
  let liveCommit: string | undefined;
  try {
    liveCommit = (await (options.fetchBuild ?? fetchLiveBuild)()).commit;
    if (!liveCommit) throw new Error('The live build has no commit.');
  } catch (error) {
    options.print(`Could not read the live Storybook build: ${error instanceof Error ? error.message : error}`);
    return 2;
  }
  options.print(`Live commit: ${liveCommit}`);
  options.print(`Local commit: ${options.localCommit}`);
  return liveCommit === options.localCommit ? 0 : 3;
}

async function getChangedPaths(): Promise<string[]> {
  const repositoryRoot = resolve(import.meta.dir, '../../..');
  const result = Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: repositoryRoot });
  if (result.exitCode !== 0) throw new Error('Could not check whether the working tree is clean.');
  return result.stdout
    .toString()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3));
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
  if (process.argv.includes('--status')) {
    process.exitCode = await runStatus({
      localCommit: commit,
      fetchBuild: fetchLiveBuild,
      print: (line) => console.log(line),
    });
  } else {
    const run = (script: string[]) =>
      Bun.spawnSync(['bun', ...script], {
        cwd: app,
        env: process.env,
        stdout: 'inherit',
        stderr: 'inherit',
      });
    await runDeployment({
      dryRun: process.argv.includes('--dry-run'),
      force: process.argv.includes('--force'),
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
}

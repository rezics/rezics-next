import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  localStorybookPublicationRevisionEnvironment,
  routeWebCheck,
  workspacePath,
  WebCheckFailure,
} from './check-placement.ts';

type DeploymentOptions = {
  dryRun: boolean;
  force?: boolean;
  commit?: string;
  cloudflareOutputDir?: string;
  localPublication?: boolean;
  build: () => Promise<void>;
  smoke: () => Promise<void>;
  /** Finite build and the same six smoke scenarios in one physical snapshot, before local publication. */
  validate?: (localPublicationCommit?: string) => Promise<void>;
  wrangler: (args: string[]) => Promise<string>;
  fetchBuild?: () => Promise<{ commit?: string }>;
  isTreeClean?: () => Promise<string[]>;
  print: (line: string) => void;
};

export async function runDeployment(options: DeploymentOptions): Promise<void> {
  const expectedCommit = options.commit;
  if (!options.dryRun && !expectedCommit)
    throw new Error('The built commit SHA is required to verify the live Storybook.');
  if (options.localPublication && (!expectedCommit || !/^[0-9a-f]{40}$/.test(expectedCommit)))
    throw new Error('Local Storybook publication requires a full committed revision.');
  if (options.localPublication && !options.validate)
    throw new Error('Local Storybook publication requires the finite validation callback.');
  if (!options.dryRun || options.localPublication) {
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
  if (options.localPublication) options.print(`Storybook validation placement: local (${expectedCommit}).`);
  if (options.validate) await options.validate(options.localPublication ? expectedCommit : undefined);
  else {
    await options.build();
    await options.smoke();
  }
  if (options.localPublication) {
    const currentCommit = getCurrentCommit();
    if (currentCommit !== expectedCommit)
      throw new Error(`Local Storybook validation changed from committed snapshot ${expectedCommit}.`);
    const changedPaths = await (options.isTreeClean ?? getChangedPaths)();
    if (changedPaths.length > 0) {
      options.print(`Cannot publish from a dirty working tree after validation:\n${changedPaths.join('\n')}`);
      throw new Error(`Cannot publish from a dirty working tree after validation: ${changedPaths.join(', ')}`);
    }
  }
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

function getCurrentCommit(): string {
  const repositoryRoot = resolve(import.meta.dir, '../../..');
  const result = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repositoryRoot });
  if (result.exitCode !== 0) throw new Error('Could not read the current Git commit SHA.');
  const commit = result.stdout.toString().trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Git did not return a full commit SHA.');
  return commit;
}

async function fetchLiveBuild(): Promise<{ commit?: string }> {
  const response = await fetch('https://storybook.rezics.com/build.json', {
    cache: 'no-store',
    headers: { 'User-Agent': 'rezics-storybook-publication/1.0' },
  });
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

/** No credentials or publication command crosses this finite remote validation boundary. */
export async function validateStorybook(localPublicationCommit?: string): Promise<void> {
  const app = resolve(import.meta.dir, '..');
  const root = resolve(app, '../..');
  const output = resolve(process.env.STORYBOOK_OUTPUT_DIR ?? resolve(app, 'storybook-static'));
  const validationEnvironment = { ...process.env };
  delete validationEnvironment[localStorybookPublicationRevisionEnvironment];
  if (localPublicationCommit)
    validationEnvironment[localStorybookPublicationRevisionEnvironment] = localPublicationCommit;
  const code = await routeWebCheck(
    {
      root,
      cwd: app,
      command: ['bun', 'scripts/storybook-deploy.ts', '--validate-only'],
      returns: [workspacePath(root, output)],
    },
    validationEnvironment,
  );
  if (code !== null) {
    if (code !== 0) throw new WebCheckFailure(code, 'Storybook validation');
    return;
  }
  for (const script of ['scripts/storybook-build.ts', 'scripts/storybook-smoke.ts']) {
    const child = Bun.spawn(['bun', script], {
      cwd: app,
      env: validationEnvironment,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const status = await child.exited;
    if (status !== 0) throw new WebCheckFailure(status, script);
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--validate-only')) {
      if (args.length !== 1) throw new Error('--validate-only cannot be combined with publication options');
      await validateStorybook();
    } else {
      const app = resolve(import.meta.dir, '..');
      const commit = getCurrentCommit();
      const localPublication = args.includes('--local');
      if (args.includes('--status')) {
        if (localPublication) throw new Error('--local is only supported for Storybook publication, not --status.');
        process.exitCode = await runStatus({
          localCommit: commit,
          fetchBuild: fetchLiveBuild,
          print: (line) => console.log(line),
        });
      } else {
        const run = async (script: string) => {
          const result = Bun.spawn(['bun', script], {
            cwd: app,
            env: process.env,
            stdin: 'inherit',
            stdout: 'inherit',
            stderr: 'inherit',
          });
          const code = await result.exited;
          if (code !== 0) throw new WebCheckFailure(code, script);
        };
        await runDeployment({
          dryRun: args.includes('--dry-run'),
          force: args.includes('--force'),
          localPublication,
          validate: validateStorybook,
          build: () => run('scripts/storybook-build.ts'),
          smoke: () => run('scripts/storybook-smoke.ts'),
          commit,
          wrangler,
          fetchBuild: fetchLiveBuild,
          print: (line) => console.log(line),
        });
      }
    }
  } catch (error) {
    console.error(error);
    process.exitCode = error instanceof WebCheckFailure ? error.code : 1;
  }
}

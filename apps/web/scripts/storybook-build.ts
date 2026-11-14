import { cpSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cleanupStorybookUiOutput } from './storybook-build-cleanup.ts';
import { formatBuildOutput } from './storybook-build-output.ts';
import { routeWebCheck, workspacePath } from './check-placement.ts';
import { operatorEntry } from './operator-entry.ts';
import {
  createStorybookArtifactStore,
  publishStorybookDirectory,
  readStorybookArtifactIdentity,
} from './storybook-artifact.ts';

const app = resolve(import.meta.dir, '..');
const root = resolve(app, '../..');
const output = resolve(process.env.STORYBOOK_OUTPUT_DIR ?? join(app, 'storybook-static'));
const entry = operatorEntry(process.argv.slice(2));
if (!entry.operator) {
  const returnedOutput = workspacePath(root, output);
  const routed = await routeWebCheck({
    root,
    cwd: app,
    command: ['bun', 'scripts/storybook-build.ts', ...entry.args],
    returns: [returnedOutput],
  });
  if (routed !== null) process.exit(routed);
}

type BuildMetadata = {
  commit: string;
  storybookVersion: string;
  builtAt: string;
  artifactIdentity: string;
  artifactBytes?: number;
};

function bytesIn(path: string): number {
  return readdirSync(path).reduce((bytes, name) => {
    const child = join(path, name);
    return bytes + (statSync(child).isDirectory() ? bytesIn(child) : statSync(child).size);
  }, 0);
}

function run(command: string[], cwd: string, env: Record<string, string | undefined> = {}) {
  const environment = { ...process.env, ...env };
  delete environment.REZICS_UI_ACCESSIBILITY_PROBE;
  const result = Bun.spawnSync(command, { cwd, env: environment, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    const details = formatBuildOutput(result.stdout.toString(), result.stderr.toString());
    process.stderr.write(details);
    throw new Error(`${command.join(' ')} failed with exit code ${result.exitCode}`);
  }
}

function currentCommit(): string {
  const commit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root });
  const sha = commit.exitCode === 0 ? commit.stdout.toString().trim() : process.env.STORYBOOK_COMMIT;
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('Could not read a full Git commit SHA.');
  return sha;
}

function storybookVersion(): string {
  const webPackage = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as {
    devDependencies: Record<string, string>;
  };
  return webPackage.devDependencies.storybook!;
}

function readBuildMetadata(path: string): BuildMetadata | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BuildMetadata;
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
    )
      return undefined;
    throw error;
  }
}

function writeBuildMetadata(outputDirectory: string, metadata: BuildMetadata): void {
  const destination = join(outputDirectory, 'build.json');
  const temporary = join(outputDirectory, `.build-${randomUUID()}.json`);
  try {
    writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function outputMatches(identity: string): BuildMetadata | undefined {
  const metadata = readBuildMetadata(join(output, 'build.json'));
  if (metadata?.artifactIdentity !== identity) return undefined;
  try {
    if (!statSync(join(output, 'index.json')).isFile()) return undefined;
    if (!statSync(join(output, 'ui', 'index.json')).isFile()) return undefined;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  return metadata;
}

async function build(): Promise<void> {
  const identity = await readStorybookArtifactIdentity(root, 'full');
  const commit = currentCommit();
  const version = storybookVersion();
  const startedAt = Date.now();
  const existing = outputMatches(identity);
  if (existing) {
    if (existing.commit !== commit || existing.storybookVersion !== version) {
      writeBuildMetadata(output, {
        ...existing,
        commit,
        storybookVersion: version,
        builtAt: new Date().toISOString(),
      });
    }
    const bytes = bytesIn(output);
    console.log(
      `Storybook artifact ${identity} reused (${bytes} bytes; nested work 0 build, 1 reuse; ${((Date.now() - startedAt) / 1000).toFixed(1)} s).`,
    );
    return;
  }

  mkdirSync(join(root, '.temp'), { recursive: true });
  cleanupStorybookUiOutput(root);
  const store = createStorybookArtifactStore(join(root, '.temp/storybook-artifacts'));
  const artifact = await store.acquire(
    identity,
    async (site, workDirectory) => {
      const uiOutput = join(workDirectory, 'ui-build');
      let buildFailed = false;
      let buildError: unknown;
      try {
        run(['bun', 'run', 'generate'], app);
        run(
          ['./node_modules/.bin/storybook', 'build', '--quiet', '--config-dir', '.storybook', '--output-dir', site],
          app,
          { STORYBOOK_UI_URL: './ui/' },
        );
        run(
          ['./node_modules/.bin/storybook', 'build', '--quiet', '--config-dir', '.storybook', '--output-dir', uiOutput],
          join(root, 'packages/ui'),
        );
        const uiDestination = join(site, 'ui');
        mkdirSync(uiDestination, { recursive: true });
        cpSync(uiOutput, uiDestination, { recursive: true });
        // The composed manager probes the legacy index and metadata URLs as well as index.json.
        cpSync(join(uiDestination, 'index.json'), join(uiDestination, 'stories.json'));
        writeFileSync(join(uiDestination, 'metadata.json'), '{}\n');
      } catch (error) {
        buildFailed = true;
        buildError = error;
      }

      let cleanupFailed = false;
      let cleanupError: unknown;
      try {
        cleanupStorybookUiOutput(root);
      } catch (error) {
        cleanupFailed = true;
        cleanupError = error;
      }
      if (buildFailed && cleanupFailed) {
        throw new AggregateError([buildError, cleanupError], 'Storybook build and generated UI cleanup both failed.', {
          cause: buildError,
        });
      }
      if (buildFailed) throw buildError;
      if (cleanupFailed) throw cleanupError;
      return { nestedBuilds: 2 };
    },
    { mode: 'full' },
  );

  const publicationDirectory = join(dirname(output), `.storybook-output-${process.pid}-${randomUUID()}`);
  let publicationFailure: unknown;
  let publicationFailed = false;
  const cleanupFailures: unknown[] = [];
  try {
    mkdirSync(dirname(output), { recursive: true });
    cpSync(artifact.site, publicationDirectory, { recursive: true });
    writeBuildMetadata(publicationDirectory, {
      commit,
      storybookVersion: version,
      builtAt: new Date().toISOString(),
      artifactIdentity: identity,
      artifactBytes: artifact.bytes,
    });
    await publishStorybookDirectory(publicationDirectory, output);
  } catch (error) {
    publicationFailed = true;
    publicationFailure = error;
  }
  try {
    rmSync(publicationDirectory, { recursive: true, force: true });
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    await artifact.release();
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (publicationFailed && cleanupFailures.length) {
    throw new AggregateError(
      [publicationFailure, ...cleanupFailures],
      `Storybook publication failed (${publicationFailure instanceof Error ? publicationFailure.message : publicationFailure}) and cleanup also failed (${cleanupFailures.map((error) => (error instanceof Error ? error.message : error)).join('; ')}).`,
      { cause: publicationFailure },
    );
  }
  if (publicationFailed) throw publicationFailure;
  if (cleanupFailures.length === 1) throw cleanupFailures[0];
  if (cleanupFailures.length) throw new AggregateError(cleanupFailures, 'Storybook publication cleanup failed.');

  console.log(
    `Storybook artifact ${identity} ${artifact.disposition} (${artifact.bytes} bytes; nested work ${artifact.nestedBuilds} build, ${artifact.nestedReuses} reuse; ${((Date.now() - startedAt) / 1000).toFixed(1)} s).`,
  );
}

await build();

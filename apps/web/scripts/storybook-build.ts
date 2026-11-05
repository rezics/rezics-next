import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanupStorybookUiOutput } from './storybook-build-cleanup.ts';
import { formatBuildOutput } from './storybook-build-output.ts';
import { routeWebCheck, workspacePath } from './check-placement.ts';
import { operatorEntry } from './operator-entry.ts';

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
const uiOutput = join(root, '.temp', `storybook-ui-${process.pid}`);
const startedAt = Date.now();

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

let buildFailed = false;
let buildError: unknown;

try {
  mkdirSync(join(root, '.temp'), { recursive: true });
  rmSync(output, { recursive: true, force: true });
  cleanupStorybookUiOutput(root);
  run(['bun', 'run', 'generate'], app);
  run(
    ['./node_modules/.bin/storybook', 'build', '--quiet', '--config-dir', '.storybook', '--output-dir', output],
    app,
    { STORYBOOK_UI_URL: './ui/' },
  );
  run(
    ['./node_modules/.bin/storybook', 'build', '--quiet', '--config-dir', '.storybook', '--output-dir', uiOutput],
    join(root, 'packages/ui'),
  );
  const uiDestination = join(output, 'ui');
  mkdirSync(uiDestination, { recursive: true });
  cpSync(uiOutput, uiDestination, { recursive: true });
  // Storybook's manager probes the legacy index and metadata URLs when loading a composed ref.
  cpSync(join(uiDestination, 'index.json'), join(uiDestination, 'stories.json'));
  writeFileSync(join(uiDestination, 'metadata.json'), '{}\n');

  const webPackage = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as {
    devDependencies: Record<string, string>;
  };
  const commit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root });
  const commitSha = commit.exitCode === 0 ? commit.stdout.toString().trim() : process.env.STORYBOOK_COMMIT;
  if (!commitSha || !/^[0-9a-f]{40}$/.test(commitSha)) throw new Error('Could not read a full Git commit SHA.');
  const metadata = {
    commit: commitSha,
    storybookVersion: webPackage.devDependencies.storybook,
    builtAt: new Date().toISOString(),
  };
  writeFileSync(join(output, 'build.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(
    `Storybook build: ${output} (${bytesIn(output)} bytes, ${((Date.now() - startedAt) / 1000).toFixed(1)} s)`,
  );
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

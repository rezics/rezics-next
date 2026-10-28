import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const app = resolve(import.meta.dir, '..');
const root = resolve(app, '../..');
const output = resolve(process.env.STORYBOOK_OUTPUT_DIR ?? join(app, 'storybook-static'));
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
    const details = `${result.stdout.toString()}\n${result.stderr.toString()}`.slice(-8_000);
    process.stderr.write(details);
    throw new Error(`${command.join(' ')} failed with exit code ${result.exitCode}`);
  }
}

try {
  mkdirSync(join(root, '.temp'), { recursive: true });
  rmSync(output, { recursive: true, force: true });
  rmSync(uiOutput, { recursive: true, force: true });
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
  writeFileSync(
    join(output, 'build-metadata.js'),
    `fetch(new URL('build.json', location.href)).then(r => r.json()).then(m => { const title = 'REZICS Storybook · ' + m.commit.slice(0, 7) + ' · ' + m.builtAt; const update = () => { if (document.title !== title) document.title = title; }; update(); new MutationObserver(update).observe(document.querySelector('title'), { childList: true, characterData: true, subtree: true }); }).catch(() => {});`,
  );
  const htmlPath = join(output, 'index.html');
  const html = readFileSync(htmlPath, 'utf8');
  writeFileSync(htmlPath, html.replace('</head>', '<script src="./build-metadata.js"></script></head>'));
  console.log(
    `Storybook build: ${output} (${bytesIn(output)} bytes, ${((Date.now() - startedAt) / 1000).toFixed(1)} s)`,
  );
} finally {
  rmSync(uiOutput, { recursive: true, force: true });
}

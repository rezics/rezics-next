import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { prepareImageContext } from '../release-images.ts';

const root = resolve(import.meta.dir, '../../..');
const temporary: string[] = [];
function temporaryDirectory() {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const path = mkdtempSync(join(root, '.temp/g-919-'));
  temporary.push(path);
  return path;
}
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function write(base: string, path: string, content: string) {
  mkdirSync(dirname(join(base, path)), { recursive: true });
  writeFileSync(join(base, path), content);
}
function git(repository: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function fixture() {
  const repository = temporaryDirectory();
  git(repository, 'init', '--quiet');
  git(repository, 'config', 'user.name', 'Release regression');
  git(repository, 'config', 'user.email', 'release-test@example.invalid');
  write(
    repository,
    'package.json',
    JSON.stringify({
      private: true,
      workspaces: ['services/*', 'packages/*', 'apps/*'],
    }),
  );
  for (const name of [
    'main',
    'account',
    'content',
    'model',
    'zone-sdk',
    'direct',
    'leaf',
    'optional',
    'peer',
    'dev',
  ]) {
    const directory = `${['main', 'account', 'content'].includes(name) ? 'services' : 'packages'}/${name}`;
    const edges =
      name === 'main'
        ? {
            dependencies: { '@test/direct': 'workspace:*' },
            devDependencies: { '@test/dev': 'workspace:*' },
          }
        : name === 'direct'
          ? {
              dependencies: { '@test/leaf': 'workspace:*' },
              optionalDependencies: { '@test/optional': 'workspace:*' },
              peerDependencies: { '@test/peer': 'workspace:*' },
            }
          : name === 'leaf'
            ? { dependencies: { '@test/direct': 'workspace:*' } }
            : {};
    write(
      repository,
      `${directory}/package.json`,
      JSON.stringify({ name: `@test/${name}`, ...edges }),
    );
    write(repository, `${directory}/src/index.ts`, `export const name = '${name}';\n`);
  }
  write(repository, 'apps/frontend/package.json', JSON.stringify({ name: '@test/frontend' }));
  write(repository, 'apps/frontend/src/index.ts', 'private frontend source');
  for (const path of [
    'scripts/ops/migrate.ts',
    'scripts/ops/production-env.ts',
    'scripts/dev/seed/open-library-fixtures.ts',
    'apps/web/features/config/env.ts',
    'apps/accounts/features/config/env.ts',
    'generated/openapi/main/public.json',
    'generated/model/manifest.json',
    'yarn.lock',
    '.yarnrc.yml',
    'infra/release/Dockerfile',
  ]) {
    write(repository, path, '{}');
  }
  write(
    repository,
    'scripts/dev/release-manifest.ts',
    `export const releaseManifest = {
    runtimes: { yarn: 'test-pin' }, applicationBase: 'test-base', images: { fuseki: 'test-fuseki' }
  }; export const releaseDigest = () => 'test-release';`,
  );
  const corepackHome = join(repository, '.temp/corepack');
  write(corepackHome, 'v1/yarn/test-pin/yarn.js', 'pinned test CLI');
  for (const path of [
    'services/main/.env.production',
    'services/main/.temp/secret',
    'services/main/node_modules/private/index.ts',
    'services/main/tests/private.ts',
    'services/main/src/index.test.ts',
    'services/main/src/index.stories.tsx',
    'services/main/fixtures/private.json',
    'services/main/.storybook/main.ts',
    'services/main/dist/stale.js',
    'packages/direct/examples/private.ts',
  ])
    write(repository, path, 'excluded');
  git(repository, 'add', '--all');
  git(repository, 'commit', '--quiet', '-m', 'Pinned fixture');
  const revision = git(repository, 'rev-parse', 'HEAD');
  return { repository, revision, corepackHome, context: join(repository, '.temp/context') };
}

test('G-919 production context follows transitive, optional, peer and cyclic workspace edges', async () => {
  const options = fixture();
  write(options.context, '.env.old', 'stale secret');
  const prepared = await prepareImageContext(options.context, options);
  expect(prepared.sourceCommit).toBe(options.revision);
  expect(
    readFileSync(join(options.context, 'runtime-workspaces.txt'), 'utf8').trim().split(' '),
  ).toEqual([
    '@test/account',
    '@test/content',
    '@test/direct',
    '@test/leaf',
    '@test/main',
    '@test/model',
    '@test/optional',
    '@test/peer',
    '@test/zone-sdk',
  ]);
  for (const name of ['direct', 'leaf', 'optional', 'peer'])
    expect(existsSync(join(options.context, `packages/${name}/src/index.ts`))).toBe(true);
  for (const path of [
    'packages/dev/src/index.ts',
    'apps/frontend/src/index.ts',
    '.env.old',
    'services/main/.env.production',
    'services/main/.temp/secret',
    'services/main/node_modules/private/index.ts',
    'services/main/tests/private.ts',
    'services/main/src/index.test.ts',
    'services/main/src/index.stories.tsx',
    'services/main/fixtures/private.json',
    'services/main/.storybook/main.ts',
    'services/main/dist/stale.js',
    'packages/direct/examples/private.ts',
  ])
    expect(existsSync(join(options.context, path))).toBe(false);
  expect(existsSync(join(options.context, 'packages/dev/package.json'))).toBe(true);
  expect(existsSync(join(options.context, 'apps/frontend/package.json'))).toBe(true);
  expect(existsSync(join(options.context, 'generated/openapi/main/public.json'))).toBe(true);
  expect(JSON.parse(readFileSync(join(options.context, 'release.json'), 'utf8'))).toEqual({
    sourceCommit: options.revision,
    base: 'test-base',
    release: 'test-release',
  });
});

test('G-919 context pins source, graph, generated contracts and release pins to one commit', async () => {
  const options = fixture();
  for (const path of [
    'services/main/src/index.ts',
    'services/main/package.json',
    'generated/openapi/main/public.json',
    'scripts/dev/release-manifest.ts',
  ])
    write(options.repository, path, 'changed checkout');
  git(options.repository, 'add', '--all');
  git(options.repository, 'commit', '--quiet', '-m', 'HEAD advanced');
  write(options.repository, 'packages/leaf/src/index.ts', 'dirty workspace');
  await prepareImageContext(options.context, options);
  expect(readFileSync(join(options.context, 'services/main/src/index.ts'), 'utf8')).toBe(
    "export const name = 'main';\n",
  );
  expect(readFileSync(join(options.context, 'packages/leaf/src/index.ts'), 'utf8')).toBe(
    "export const name = 'leaf';\n",
  );
  expect(readFileSync(join(options.context, 'generated/openapi/main/public.json'), 'utf8')).toBe(
    '{}',
  );
  expect(readFileSync(join(options.context, 'yarn.cjs'), 'utf8')).toBe('pinned test CLI');
});

test('G-919 reused context loads release pins from the newly selected commit', async () => {
  const options = fixture();
  await prepareImageContext(options.context, options);
  write(
    options.repository,
    'scripts/dev/release-manifest.ts',
    `export const releaseManifest = {
    runtimes: { yarn: 'test-pin' }, applicationBase: 'new-base', images: { fuseki: 'new-fuseki' }
  }; export const releaseDigest = () => 'new-release';`,
  );
  git(options.repository, 'add', '--all');
  git(options.repository, 'commit', '--quiet', '-m', 'New pins');
  const prepared = await prepareImageContext(options.context, { ...options, revision: 'HEAD' });
  expect(prepared.base).toBe('new-base');
  expect(prepared.release).toBe('new-release');
  expect(prepared.releaseManifest.images.fuseki).toBe('new-fuseki');
});

test('G-919 missing production workspace edges fail before a Docker build', async () => {
  const options = fixture();
  write(
    options.repository,
    'packages/leaf/package.json',
    JSON.stringify({
      name: '@test/leaf',
      dependencies: { '@test/missing': 'workspace:*' },
    }),
  );
  git(options.repository, 'add', '--all');
  git(options.repository, 'commit', '--quiet', '-m', 'Missing edge');
  await expect(
    prepareImageContext(options.context, { ...options, revision: 'HEAD' }),
  ).rejects.toThrow('Unresolved production workspace edge');
});

test('G-919 source symlinks cannot include private files', async () => {
  const options = fixture();
  symlinkSync(
    '../../.temp/corepack/v1/yarn/test-pin/yarn.js',
    join(options.repository, 'services/main/private.ts'),
  );
  git(options.repository, 'add', '--all');
  git(options.repository, 'commit', '--quiet', '-m', 'Unsafe source symlink');
  await expect(
    prepareImageContext(options.context, { ...options, revision: 'HEAD' }),
  ).rejects.toThrow('Release payload must be a regular Git file');
});

test('G-919 repository context resolves wiki-toolkit and Account public contract through production Yarn', async () => {
  const context = join(temporaryDirectory(), 'context');
  await prepareImageContext(context);
  expect(existsSync(join(context, 'packages/wiki-toolkit/protocol/locator.ts'))).toBe(true);
  const document = JSON.parse(
    readFileSync(join(context, 'generated/openapi/main/public.json'), 'utf8'),
  );
  expect(document.openapi).toBeDefined();
  const names = readFileSync(join(context, 'runtime-workspaces.txt'), 'utf8').trim().split(' ');
  const focused = spawnSync(
    process.execPath,
    ['yarn.cjs', 'workspaces', 'focus', ...names, '--production'],
    {
      cwd: context,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 4_000_000,
      env: {
        ...process.env,
        YARN_ENABLE_SCRIPTS: 'false',
        YARN_ENABLE_IMMUTABLE_INSTALLS: 'true',
        YARN_ENABLE_GLOBAL_CACHE: 'false',
        YARN_CACHE_FOLDER: join(root, '.temp/g-919-yarn-cache'),
        YARN_GLOBAL_FOLDER: join(root, '.temp/g-919-yarn-global'),
      },
    },
  );
  if (focused.error || focused.status !== 0)
    throw new Error(`${focused.error?.message ?? ''}\n${focused.stdout}\n${focused.stderr}`);
  // Use a fresh resolver: this test process has already loaded repository workspaces.
  const resolved = spawnSync(
    process.execPath,
    [
      '--eval',
      'console.log(Bun.resolveSync("@rezics/wiki-toolkit/protocol", process.cwd() + "/services/main/src"))',
    ],
    { cwd: context, encoding: 'utf8' },
  );
  expect(resolved.status).toBe(0);
  expect(resolved.stdout.trim()).toBe(join(context, 'packages/wiki-toolkit/protocol/index.ts'));
  expect(existsSync(join(context, 'node_modules/vinext'))).toBe(false);
  const auth = Bun.build({
    entrypoints: [join(context, 'services/account/src/auth.ts')],
    target: 'bun',
    packages: 'external',
  });
  expect((await auth).success).toBe(true);
}, 150_000);

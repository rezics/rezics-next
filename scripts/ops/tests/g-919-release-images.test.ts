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
import { productionExample } from './g-722-fixture.ts';

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
    'document',
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
  write(repository, '.yarn/patches/runtime.patch', 'pinned resolver patch');
  for (const path of [
    'scripts/ops/migrate.ts',
    'scripts/ops/postgres-preflight.ts',
    'scripts/ops/production-env.ts',
    'scripts/lib/migration-order.ts',
    'scripts/lib/concurrent-index.ts',
    'scripts/dev/seed/open-library-fixtures.ts',
    'apps/web/features/config/env.ts',
    'apps/accounts/features/config/env.ts',
    'generated/openapi/main/public.json',
    'generated/model/manifest.json',
    'yarn.lock',
    '.yarnrc.yml',
    'infra/release/Dockerfile',
    'infra/release/postgres-provision.sql',
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
    '.yarn/cache/private.zip',
    '.yarn/patches/private.json',
    '.yarn/patches/.env.patch',
    '.yarn/patches/.temp/private.patch',
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
    '@test/document',
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
    '.yarn/cache/private.zip',
    '.yarn/patches/private.json',
    '.yarn/patches/.env.patch',
    '.yarn/patches/.temp/private.patch',
  ])
    expect(existsSync(join(options.context, path))).toBe(false);
  expect(existsSync(join(options.context, 'packages/dev/package.json'))).toBe(true);
  expect(existsSync(join(options.context, 'apps/frontend/package.json'))).toBe(true);
  expect(existsSync(join(options.context, 'generated/openapi/main/public.json'))).toBe(true);
  expect(existsSync(join(options.context, 'scripts/lib/migration-order.ts'))).toBe(true);
  expect(existsSync(join(options.context, 'scripts/lib/concurrent-index.ts'))).toBe(true);
  expect(existsSync(join(options.context, 'scripts/ops/postgres-preflight.ts'))).toBe(true);
  expect(existsSync(join(options.context, 'infra/release/postgres-provision.sql'))).toBe(true);
  expect(readFileSync(join(options.context, '.yarn/patches/runtime.patch'), 'utf8')).toBe(
    'pinned resolver patch',
  );
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
    '.yarn/patches/runtime.patch',
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
  expect(readFileSync(join(options.context, '.yarn/patches/runtime.patch'), 'utf8')).toBe(
    'pinned resolver patch',
  );
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
  expect<string>(prepared.base).toBe('new-base');
  expect(prepared.release).toBe('new-release');
  expect<string>(prepared.releaseManifest.images.fuseki).toBe('new-fuseki');
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

test('G-919 patch symlinks cannot include private files', async () => {
  const options = fixture();
  symlinkSync(
    '../../.temp/corepack/v1/yarn/test-pin/yarn.js',
    join(options.repository, '.yarn/patches/private.patch'),
  );
  git(options.repository, 'add', '--all');
  git(options.repository, 'commit', '--quiet', '-m', 'Unsafe patch symlink');
  await expect(
    prepareImageContext(options.context, { ...options, revision: 'HEAD' }),
  ).rejects.toThrow('Release payload must be a regular Git file');
});

test('production image context loads owner scopes, preflight and native dependencies through focused Yarn', async () => {
  const context = join(temporaryDirectory(), 'context');
  await prepareImageContext(context);
  expect(existsSync(join(context, 'packages/wiki-toolkit/protocol/locator.ts'))).toBe(true);
  expect(existsSync(join(context, '.yarn/patches/elysia-opentelemetry-status.patch'))).toBe(true);
  // Glob-loaded owner declarations are invisible to a static import resolver.
  const scopeDeclarations = git(
    root,
    'ls-tree',
    '-r',
    '--name-only',
    'HEAD',
    '--',
    'services/account/src/oauth-scopes',
  )
    .split('\n')
    .filter((path) => path.endsWith('.ts'));
  expect(scopeDeclarations.length).toBeGreaterThan(0);
  for (const path of scopeDeclarations) expect(existsSync(join(context, path))).toBe(true);
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
  const loaded = spawnSync(
    process.execPath,
    [
      '--eval',
      `
      // The context lives below the checkout; refuse ancestor dependency fallback.
      for (const name of ['sharp', 'envalid', 'pg', '@rezics/observability/config']) {
        if (!Bun.resolveSync(name, process.cwd() + '/services/main/src').startsWith(process.cwd() + '/'))
          throw new Error('Dependency escaped the production context: ' + name);
      }
      const scopes = await import('./services/account/src/oauth-scopes.ts');
      if (!scopes.providerScopes.includes('context:read') ||
          !scopes.closedGroupScopes.includes('package:install') ||
          scopes.dynamicRegistrationScopes(['openid', 'package:install']).join(' ') !== 'openid')
        throw new Error('Installed Account scope contract differs');
      const { checkProductionEnv } = await import('./scripts/ops/production-env.ts');
      checkProductionEnv(JSON.parse(process.env.RELEASE_TEST_ENV));
      const { postgresPreflightConfig } = await import('./scripts/ops/postgres-preflight.ts');
      if (postgresPreflightConfig('postgres://access@postgres.internal/access').options !==
          '-c default_transaction_read_only=on') throw new Error('PostgreSQL probe missing');
      const sharp = (await import('sharp')).default;
      const png = await sharp({ create: { width: 1, height: 1, channels: 3,
        background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
      if ((await sharp(png).metadata()).format !== 'png') throw new Error('Native decoder failed');
    `,
    ],
    {
      cwd: context,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, RELEASE_TEST_ENV: JSON.stringify(productionExample()) },
    },
  );
  if (loaded.error || loaded.status !== 0)
    throw new Error(
      `Focused runtime load failed: ${loaded.error?.message ?? ''}\n${loaded.stderr}`,
    );
  const auth = Bun.build({
    entrypoints: [join(context, 'services/account/src/auth.ts')],
    target: 'bun',
    packages: 'external',
  });
  expect((await auth).success).toBe(true);
}, 150_000);

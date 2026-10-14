import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { prepareImageContext, runtimeArtifacts, runtimeEntries } from './release-images.ts';

const root = resolve(import.meta.dir, '../..');
const temporary: string[] = [];
function temporaryDirectory() {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const path = mkdtempSync(join(root, '.temp/release-images-test-'));
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
    'generated/query/templates.ts',
    'generated/model/manifest.json',
    'model/compiler/registry.ts',
    'model/compiler/outputs.ts',
    'model/compiler/ir.ts',
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
  for (const entry of [...runtimeEntries, ...runtimeArtifacts]) {
    if (!existsSync(join(repository, entry))) write(repository, entry, 'export {};');
  }
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

test.each(runtimeEntries)('image runtime closure follows pinned transitive imports from %s', async (entry) => {
  const options = fixture();
  write(options.repository, entry, `
    import '../../../runtime-adapters/bridge';
    import type { PrivateType } from './missing-types';
  `.replace('../../../', '../'.repeat(dirname(entry).split('/').length)));
  write(options.repository, 'runtime-adapters/bridge.ts', `
    export { value } from '@test/imported/runtime';
    export const lazy = () => import('./lazy');
    import { readFileSync } from 'node:fs';
    import { Glob } from 'bun';
  `);
  write(options.repository, 'runtime-adapters/lazy.ts', "export const value = require('./runtime-package.json');");
  write(options.repository, 'runtime-adapters/runtime-package.json', '{"pinned":true}');
  write(options.repository, 'packages/imported/package.json', JSON.stringify({
    name: '@test/imported',
    exports: { './runtime': './src/runtime.ts' },
    dependencies: { '@test/leaf': 'workspace:*' },
  }));
  write(options.repository, 'packages/imported/src/runtime.ts', "export { value } from '../../../runtime-adapters/runtime-package.json';");
  git(options.repository, 'add', '--all');
  git(options.repository, 'commit', '--quiet', '-m', 'New runtime import');
  const revision = git(options.repository, 'rev-parse', 'HEAD');
  write(options.repository, 'runtime-adapters/runtime-package.json', '{"live":true}');
  write(options.repository, entry, "import './missing-live.ts';");
  await prepareImageContext(options.context, { ...options, revision });
  for (const path of ['runtime-adapters/bridge.ts', 'runtime-adapters/lazy.ts',
    'runtime-adapters/runtime-package.json', 'packages/imported/src/runtime.ts']) {
    expect(existsSync(join(options.context, path)), path).toBe(true);
  }
  expect(readFileSync(join(options.context, 'runtime-adapters/runtime-package.json'), 'utf8')).toBe('{"pinned":true}');
  expect(readFileSync(join(options.context, 'runtime-workspaces.txt'), 'utf8')).toContain('@test/imported');
});

test.each(['./missing.ts', './index.test.ts', '../.env.production', './../../../outside.ts']) (
  'image runtime closure refuses required import %s before replacing a context', async (imported) => {
    const options = fixture();
    write(options.context, 'previous', 'previous context');
    write(options.repository, 'services/main/src/index.ts', `import '${imported}';`);
    git(options.repository, 'add', '--all');
    git(options.repository, 'commit', '--quiet', '-m', 'Unavailable runtime import');
    await expect(prepareImageContext(options.context, { ...options, revision: 'HEAD' }))
      .rejects.toThrow('Unresolved release runtime import');
    expect(readFileSync(join(options.context, 'previous'), 'utf8')).toBe('previous context');
  },
);

test('image runtime closure refuses a package absent from production dependency focus', async () => {
  const options = fixture();
  write(options.repository, 'services/main/src/index.ts', "import 'missing-package/subpath';");
  git(options.repository, 'add', '--all');
  git(options.repository, 'commit', '--quiet', '-m', 'Missing production dependency');
  await expect(prepareImageContext(options.context, { ...options, revision: 'HEAD' }))
    .rejects.toThrow('Unresolved production runtime dependency');
});

test('image runtime closure prepares the repository snapshot without installing dependencies', async () => {
  const context = join(temporaryDirectory(), 'context');
  await prepareImageContext(context);
  for (const path of runtimeEntries) expect(existsSync(join(context, path)), path).toBe(true);
  expect(existsSync(join(context, 'model/compiler/outputs.ts'))).toBe(true);
  expect(existsSync(join(context, 'node_modules'))).toBe(false);
  const launcher = readFileSync(join(context, 'infra/release/entrypoint.ts'), 'utf8');
  for (const match of launcher.matchAll(/['"](?:\.\/)?((?:services|scripts)\/[^'"]+\.ts)['"]/g)) {
    expect(runtimeEntries.concat(runtimeArtifacts), `launcher root ${match[1]}`).toContain(match[1]!);
  }
  expect(readFileSync(join(context, 'infra/release/Dockerfile'), 'utf8'))
    .toContain('COPY --from=dependencies --chown=bun:bun /app/ ./');
  expect(readFileSync(join(context, 'infra/release/Dockerfile'), 'utf8'))
    .toContain('releaseRuntimeFiles(process.cwd(), entry)');
  expect(JSON.parse(readFileSync(join(context, 'runtime-entrypoints.json'), 'utf8'))).toEqual(runtimeEntries);
});

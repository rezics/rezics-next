import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { releaseManifest, releaseDigest } from '../dev/release-manifest.ts';

const root = resolve(import.meta.dir, '../..');
export const runtimeRoles = ['main', 'relay', 'relay-init', 'account', 'migrate'] as const;

function run(args: string[], timeout = 120_000) {
  const result = spawnSync('docker', args, {
    cwd: root,
    encoding: 'utf8',
    timeout,
    maxBuffer: 4_000_000,
  });
  if (args[0] === 'build') {
    writeFileSync(
      join(root, '.temp/release-images/build.log'),
      `${result.stdout}\n${result.stderr}`,
    );
  }
  if (result.error || result.status !== 0)
    throw new Error(
      `Docker ${args[0]} failed: ${(result.stderr || result.error?.message || '').slice(-2000)}`,
    );
  return result.stdout.trim();
}

/** Allowlist source payloads; dependencies are installed in the builder, never
 * copied from a developer node_modules or an environment/fixture directory. */
function copyTree(source: string, target: string) {
  cpSync(source, target, {
    recursive: true,
    filter: (path) => {
      const name = path.split('/').at(-1)!;
      return (
        !['node_modules', '.temp', '.git', 'dist', 'tests', '.storybook'].includes(name) &&
        !name.startsWith('.env') &&
        !/\.(?:test|spec|stories)\.[cm]?[jt]sx?$/.test(name)
      );
    },
  });
}

export function prepareImageContext(destination: string) {
  mkdirSync(destination, { recursive: true });
  for (const file of ['package.json', 'yarn.lock', '.yarnrc.yml'])
    cpSync(join(root, file), join(destination, file));
  for (const directory of [
    'services/main',
    'services/account',
    'services/content',
    'packages/model',
    'packages/zone-sdk',
    'generated/model',
  ]) {
    copyTree(join(root, directory), join(destination, directory));
  }
  // Keep workspace manifests so immutable Yarn resolution sees the same graph;
  // focus removes the frontend and build-tool dependencies from the final tree.
  for (const directory of ['apps/web', 'apps/accounts', 'apps/about', 'packages/ui', 'apphost']) {
    mkdirSync(join(destination, directory), { recursive: true });
    cpSync(join(root, directory, 'package.json'), join(destination, directory, 'package.json'));
  }
  for (const file of [
    'scripts/ops/migrate.ts',
    'scripts/ops/production-env.ts',
    'scripts/dev/release-manifest.ts',
    'scripts/dev/seed/open-library-fixtures.ts',
    'apps/web/features/config/env.ts',
    'apps/accounts/features/config/env.ts',
  ]) {
    mkdirSync(dirname(join(destination, file)), { recursive: true });
    cpSync(join(root, file), join(destination, file));
  }
  copyTree(join(root, 'infra/release'), join(destination, 'infra/release'));
  const corepackHome = process.env.COREPACK_HOME ?? join(homedir(), '.cache/node/corepack');
  const yarn = join(corepackHome, 'v1/yarn', releaseManifest.runtimes.yarn, 'yarn.js');
  if (!existsSync(yarn)) throw new Error('Pinned Yarn CLI missing; run task install');
  cpSync(yarn, join(destination, 'yarn.cjs'));
  const metadata = {
    base: releaseManifest.applicationBase,
    release: releaseDigest(),
  };
  writeFileSync(join(destination, 'release.json'), `${JSON.stringify(metadata)}\n`);
}

export function buildReleaseImages() {
  const context = join(root, '.temp/release-images/context');
  rmSync(context, { recursive: true, force: true });
  prepareImageContext(context);
  const inputs: Array<[string, string]> = [];
  function visit(directory: string, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(prefix, entry.name);
      if (entry.isDirectory()) visit(join(directory, entry.name), path);
      else
        inputs.push([
          path,
          createHash('sha256')
            .update(readFileSync(join(directory, entry.name)))
            .digest('hex'),
        ]);
    }
  }
  visit(context);
  const inputDigest = createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
  const images: Record<string, { reference: string; digest: string }> = {};
  for (const role of runtimeRoles) {
    const reference = `rezics/${role}:${inputDigest}`;
    run(
      [
        'build',
        '--provenance=false',
        '--sbom=false',
        '--build-arg',
        `BUN_IMAGE=${releaseManifest.applicationBase}`,
        '--build-arg',
        'SOURCE_DATE_EPOCH=0',
        '--build-arg',
        `ROLE=${role}`,
        '--tag',
        reference,
        '--file',
        join(context, 'infra/release/Dockerfile'),
        context,
      ],
      600_000,
    );
    const digest = run(['image', 'inspect', reference, '--format', '{{.Id}}'], 10_000);
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`Invalid ${role} OCI identity`);
    images[role] = { reference, digest };
  }
  const fusekiDigest = run(
    ['image', 'inspect', releaseManifest.images.fuseki, '--format', '{{.Id}}'],
    10_000,
  );
  if (!/^sha256:[a-f0-9]{64}$/.test(fusekiDigest))
    throw new Error('Pinned Fuseki image is missing');
  images.fuseki = { reference: releaseManifest.images.fuseki, digest: fusekiDigest };
  const manifest = {
    schema: 'rezics-oci-release-v1',
    release: releaseDigest(),
    inputDigest,
    platform: run(['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'], 10_000),
    base: releaseManifest.applicationBase,
    images,
  };
  const path = join(root, '.temp/release-images', `${inputDigest}.json`);
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, 'utf8') !== bytes)
    throw new Error('Unchanged inputs produced different image identities');
  writeFileSync(path, bytes);
  return path;
}

if (import.meta.main) {
  if (process.argv[2] === '--inspect-base')
    console.log(
      run(['buildx', 'imagetools', 'inspect', `oven/bun:${releaseManifest.runtimes.bun}`]),
    );
  else console.log(buildReleaseImages());
}

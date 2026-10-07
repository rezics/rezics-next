import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
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
import { releaseManifest, type ReleaseManifest } from '../dev/release-manifest.ts';

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

// These roots also cover cross-workspace relative imports, which Yarn cannot see.
const runtimeWorkspaceRoots = [
  'services/main',
  'services/account',
  'services/content',
  'packages/model',
  'packages/document',
  'packages/zone-sdk',
];
const runtimeArtifacts = [
  'scripts/ops/migrate.ts',
  'scripts/ops/postgres-preflight.ts',
  'scripts/ops/production-env.ts',
  'scripts/lib/migration-order.ts',
  'scripts/dev/release-manifest.ts',
  'scripts/dev/seed/open-library-fixtures.ts',
  'apps/web/features/config/env.ts',
  'apps/accounts/features/config/env.ts',
  // Account consent and Main MCP discovery inspect the installed public contract.
  'generated/openapi/main/public.json',
];

interface GitFile {
  mode: string;
  oid: string;
  path: string;
}
interface WorkspaceManifest {
  name: string;
  workspaces?: string[] | { packages: string[] };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function git(repository: string, args: string[], input?: string): Buffer {
  const result = spawnSync('git', args, {
    cwd: repository,
    input,
    timeout: 120_000,
    maxBuffer: 128_000_000,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `Release source Git ${args[0]} failed: ${result.stderr?.toString() || result.error?.message}`,
    );
  return result.stdout;
}

/** Read Git objects, never working-tree files or symlink targets. All reads use
 * the one resolved commit even if HEAD or the checkout changes during a build. */
function sourceTree(repository: string, revision: string) {
  const commit = git(repository, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${revision}^{commit}`,
  ])
    .toString()
    .trim();
  const files = git(repository, ['ls-tree', '-rz', commit])
    .toString()
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const match = /^(\d+) blob ([a-f0-9]+)\t(.+)$/s.exec(entry);
      if (!match) throw new Error(`Unsupported release source entry: ${entry}`);
      return { mode: match[1]!, oid: match[2]!, path: match[3]! };
    });
  return { commit, files };
}

function sourceBlobs(repository: string, files: GitFile[]): Map<string, Buffer> {
  const bytes = git(
    repository,
    ['cat-file', '--batch'],
    files.map((file) => file.oid).join('\n') + '\n',
  );
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  for (const file of files) {
    const end = bytes.indexOf(10, offset);
    const [oid, type, size] = bytes.subarray(offset, end).toString().split(' ');
    if (oid !== file.oid || type !== 'blob' || !/^\d+$/.test(size ?? ''))
      throw new Error(`Invalid release source blob: ${file.path}`);
    offset = end + 1;
    blobs.set(file.path, bytes.subarray(offset, offset + Number(size)));
    offset += Number(size) + 1;
  }
  if (offset !== bytes.length) throw new Error('Release source blob stream differs');
  return blobs;
}

function productionPath(path: string): boolean {
  return path
    .split('/')
    .every(
      (name) =>
        ![
          'node_modules',
          '.temp',
          '.git',
          '.yarn',
          'dist',
          'coverage',
          'test',
          'tests',
          '__tests__',
          'fixtures',
          '__fixtures__',
          '.storybook',
          'docs',
          'examples',
          'skill',
        ].includes(name) &&
        !name.startsWith('.env') &&
        !/\.(?:test|spec|stories)\.[cm]?[jt]sx?$/.test(name),
    );
}

export async function prepareImageContext(
  destination: string,
  options: {
    repository?: string;
    revision?: string;
    corepackHome?: string;
  } = {},
) {
  const repository = options.repository ?? root;
  const { commit: sourceCommit, files } = sourceTree(repository, options.revision ?? 'HEAD');
  const byPath = new Map(files.map((file) => [file.path, file]));
  function required(path: string): GitFile {
    const file = byPath.get(path);
    if (!file) throw new Error(`Pinned release source is missing ${path}`);
    return file;
  }
  const rootManifest = JSON.parse(
    git(repository, ['show', `${sourceCommit}:package.json`]).toString(),
  ) as WorkspaceManifest;
  const patterns = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces
    : rootManifest.workspaces?.packages;
  if (!patterns?.length) throw new Error('Pinned release source has no workspace graph');
  const manifests = files.filter((file) =>
    patterns.some((pattern) => new Bun.Glob(`${pattern}/package.json`).match(file.path)),
  );
  const manifestBlobs = sourceBlobs(repository, manifests);
  const workspaces = new Map<string, { directory: string; manifest: WorkspaceManifest }>();
  for (const file of manifests) {
    const manifest = JSON.parse(manifestBlobs.get(file.path)!.toString()) as WorkspaceManifest;
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(manifest.name) || workspaces.has(manifest.name))
      throw new Error(`Invalid or duplicate release workspace: ${manifest.name}`);
    workspaces.set(manifest.name, { directory: dirname(file.path), manifest });
  }
  const production = new Set<string>();
  function include(name: string) {
    if (production.has(name)) return;
    const workspace = workspaces.get(name);
    if (!workspace) throw new Error(`Missing production workspace: ${name}`);
    production.add(name);
    const edges = {
      ...workspace.manifest.peerDependencies,
      ...workspace.manifest.dependencies,
      ...workspace.manifest.optionalDependencies,
    };
    for (const [dependency, range] of Object.entries(edges)) {
      const target =
        workspaces.get(dependency) ??
        (range.startsWith('workspace:')
          ? [...workspaces.values()].find(
              (candidate) =>
                candidate.directory ===
                resolve('/', workspace.directory, range.slice('workspace:'.length)).slice(1),
            )
          : undefined);
      if (target) include(target.manifest.name);
      else if (range.startsWith('workspace:'))
        throw new Error(
          `Unresolved production workspace edge: ${name} -> ${dependency} (${range})`,
        );
    }
  }
  for (const directory of runtimeWorkspaceRoots) {
    const workspace = [...workspaces.values()].find(
      (workspace) => workspace.directory === directory,
    );
    if (!workspace) throw new Error(`Missing runtime workspace root: ${directory}`);
    include(workspace.manifest.name);
  }
  const directories = [...production]
    .map((name) => workspaces.get(name)!.directory)
    .concat(['generated/model', 'infra/release']);
  const selected = new Map<string, GitFile>();
  for (const file of ['package.json', 'yarn.lock', '.yarnrc.yml', ...runtimeArtifacts])
    selected.set(file, required(file));
  // Immutable resolution needs every manifest, including development workspaces;
  // only the production closure gets source payloads and installed dependencies.
  for (const file of manifests) selected.set(file.path, file);
  for (const file of files) {
    // Yarn resolves the pinned lockfile's patches during production focus too.
    // Retain Git patch inputs while keeping .yarn caches and other state out.
    if (
      file.path.startsWith('.yarn/patches/') && file.path.endsWith('.patch')
      && productionPath(file.path.slice('.yarn/patches/'.length))
    ) {
      selected.set(file.path, file);
    }
    if (
      directories.some((directory) => file.path.startsWith(`${directory}/`)) &&
      productionPath(file.path)
    )
      selected.set(file.path, file);
  }
  for (const file of selected.values()) {
    if (!['100644', '100755'].includes(file.mode))
      throw new Error(`Release payload must be a regular Git file: ${file.path}`);
  }
  // A reused destination must not retain private or stale payloads.
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  const blobs = sourceBlobs(repository, [...selected.values()]);
  for (const file of selected.values()) {
    const target = join(destination, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, blobs.get(file.path)!);
    chmodSync(target, file.mode === '100755' ? 0o755 : 0o644);
  }
  const pins = (await import(
    `${join(resolve(destination), 'scripts/dev/release-manifest.ts')}?commit=${sourceCommit}`
  )) as {
    releaseManifest: ReleaseManifest;
    releaseDigest: () => string;
  };
  const corepackHome =
    options.corepackHome ?? process.env.COREPACK_HOME ?? join(homedir(), '.cache/node/corepack');
  const yarn = join(corepackHome, 'v1/yarn', pins.releaseManifest.runtimes.yarn, 'yarn.js');
  if (!existsSync(yarn)) throw new Error('Pinned Yarn CLI missing; run task install');
  cpSync(yarn, join(destination, 'yarn.cjs'));
  writeFileSync(
    join(destination, 'runtime-workspaces.txt'),
    `${[...production].sort().join(' ')}\n`,
  );
  const metadata = {
    sourceCommit,
    base: pins.releaseManifest.applicationBase,
    release: pins.releaseDigest(),
  };
  writeFileSync(join(destination, 'release.json'), `${JSON.stringify(metadata)}\n`);
  return { ...metadata, releaseManifest: pins.releaseManifest };
}

export async function buildReleaseImages(revision = 'HEAD') {
  const context = join(root, '.temp/release-images/context');
  rmSync(context, { recursive: true, force: true });
  const source = await prepareImageContext(context, { revision });
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
        `BUN_IMAGE=${source.releaseManifest.applicationBase}`,
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
    ['image', 'inspect', source.releaseManifest.images.fuseki, '--format', '{{.Id}}'],
    10_000,
  );
  if (!/^sha256:[a-f0-9]{64}$/.test(fusekiDigest))
    throw new Error('Pinned Fuseki image is missing');
  images.fuseki = { reference: source.releaseManifest.images.fuseki, digest: fusekiDigest };
  const manifest = {
    schema: 'rezics-oci-release-v1',
    sourceCommit: source.sourceCommit,
    release: source.release,
    inputDigest,
    platform: run(['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'], 10_000),
    base: source.base,
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
  else {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--commit'))
      throw new Error('Expected --commit <revision> or --inspect-base');
    console.log(await buildReleaseImages(args[1]));
  }
}

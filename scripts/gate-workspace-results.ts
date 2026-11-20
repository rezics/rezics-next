import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { release } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import {
  CHECK_RESULT_SCHEMA,
  CheckResults,
  checkResultFingerprint,
  checkResultsMigration,
  checkWorkspaceClosure,
  reusableCommand,
  sharedCheckInput,
} from '../tools/goal/src/check-results.ts';
import { CHECK_HOST_RUNS_ROOT, recognizeCheckHostRun } from './check-placement.ts';
import { gitList } from './check-source.ts';
import { repositoryBun } from './remote-check.ts';
import type { Workspace } from './gate.ts';

const hostRoot = dirname(CHECK_HOST_RUNS_ROOT);
const runId = /^[a-z0-9-]{1,64}$/;
const sha256 = /^[a-f0-9]{64}$/;
const revision = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const skipped = new Set(['.git', '.temp', 'node_modules']);
// These process and transport values describe a particular invocation, not the workspace check.
const transientEnv = new Set([
  '_',
  'OLDPWD',
  'PWD',
  'SHLVL',
  'SSH_CLIENT',
  'SSH_CONNECTION',
  'SSH_TTY',
  'INVOCATION_ID',
  'JOURNAL_STREAM',
  'SYSTEMD_EXEC_PID',
  'REMOTE_CHECK_HOST_PREPARATION_DEADLINE',
  'REZICS_CHECK_RUN',
  'REZICS_CHECK_SLICE',
  'GATE_RESULT_FILE',
  'GATE_GROUP_INDEX',
]);

const sharedPaths = [
  'services/auth/scripts/database.ts',
  'services/kernel/scripts/database.ts',
  'services/kernel/db/search/opensearch/Dockerfile',
  'tools/goal/src/test-environment.ts',
  'tools/goal/src/native-unit-context.ts',
  'tools/goal/defaults.json',
  '.github/workflows',
];
const crossWorkspaceInputs: Record<string, string[]> = {
  'apps/auth': [
    'services/auth/package.json',
    'services/auth/src',
    'services/kernel/package.json',
    'services/kernel/src/access/handle-policy.ts',
    'services/kernel/src/access/contract',
    'apps/web/package.json',
    'apps/web/scripts/message-imports.ts',
    'apps/web/tests/native/auth-page-app.ts',
    'apps/web/tests/native/lifecycle.ts',
    'apps/web/tests/native/native-auth-security-fixture.ts',
    'apps/web/tests/native/vite-environment.ts',
    'apps/web/tests/native/web-document-modules.ts',
    'apps/web/tests/support/server-custody.ts',
    'packages/definitions',
  ],
  // UI and the service suites include repository-wide source or placement assertions.
  'packages/ui': ['apps', 'services', 'packages'],
  'services/kernel': ['apps', 'services', 'packages', 'docs', 'tools', '.reference'],
  'services/auth': ['apps/auth', 'apps/web', 'services/importer', 'services/kernel', 'docs', 'Taskfile.yml'],
  'packages/definitions': [
    'services/kernel',
    'apps/web/src/kernel/recorded/definitions-active.json',
    'apps/web/src/kernel/recorded/definitions-release.json',
  ],
  'packages/editor': ['apps/web'],
  'packages/conversion': ['services/importer', 'services/kernel'],
  'services/importer': ['packages/conversion', 'services/kernel', 'apps/web/package.json'],
};

// These checks call other package scripts. Qualify their exact recipes and lifecycle hooks.
const scriptsWithInputs: Record<string, Record<string, string>> = {
  'apps/auth': {
    check:
      'oxfmt --check . && bun run generate && bun run generate:routes && bun check --no-script -p tsconfig.json && bun run test && bun run build',
    generate: 'bun scripts/generate.ts',
    'generate:routes': 'vite build --config vite.config.ts --mode development --emptyOutDir false',
    test: 'bun scripts/isolated.ts bun test',
    build: 'vite build --config vite.config.ts',
  },
  'packages/editor': {
    check: 'oxfmt --check . && bun check --no-script -p tsconfig.json && bun run typecheck && bun run test',
    typecheck: 'bun check --no-script -p tsconfig.sources.json',
    test: 'bun ../ui/scripts/isolated.ts bun test',
  },
  'packages/ui': {
    check: 'oxfmt --check . && bun check --no-script -p tsconfig.json && bun run test #bun test',
    test: 'bun scripts/isolated.ts bun test',
  },
};

const authOutputs = [
  'apps/auth/project.inlang/.gitignore',
  'apps/auth/project.inlang/.meta.json',
  'apps/auth/project.inlang/README.md',
  'apps/auth/project.inlang/cache',
  'apps/auth/src/paraglide',
  'apps/auth/src/routeTree.gen.ts',
  'apps/auth/dist',
  'apps/auth/.output',
  'apps/auth/.wrangler',
  'apps/auth/.cloudflare',
  'apps/auth/.tanstack',
];
const browserWorkspaces = new Set(['apps/auth', 'packages/ui', 'packages/editor']);

type Source = { run: string; revision: string; sourceSha256: string };
type Producer = Source & { preparedSha256: string };
type Environment = Record<string, string | undefined>;

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function secureStat(path: string, directory: boolean) {
  const stat = lstatSync(path);
  if (
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o022) !== 0 ||
    (!directory && stat.nlink !== 1)
  )
    throw new Error('invalid Gate evidence path');
  return stat;
}

function preparedDigest(receipts: string, host: string, source: Source): string | undefined {
  if (!runId.test(source.run) || !revision.test(source.revision) || !sha256.test(source.sourceSha256)) return;
  const directory = join(receipts, source.run);
  const path = join(directory, 'prepared-inputs.json');
  secureStat(directory, true);
  const stat = secureStat(path, false);
  if (stat.size > 4096) return;
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (
    value.schema === 1 &&
    value.host === host &&
    value.run === source.run &&
    value.sourceSha256 === source.sourceSha256 &&
    sha256.test(value.manifestSha256) &&
    Number.isSafeInteger(value.fileCount) &&
    value.fileCount > 0 &&
    Number.isSafeInteger(value.totalBytes) &&
    value.totalBytes > 0
  )
    return value.manifestSha256;
}

function scopes(root: string, directory: string): string[] {
  const manifests = new Map<string, { name: string }>();
  const names = new Map<string, string>();
  for (const path of new Bun.Glob('{apps,services,packages,tools}/*/package.json').scanSync({ cwd: root })) {
    const workspace = dirname(path);
    const manifest = JSON.parse(readFileSync(join(root, path), 'utf8'));
    if (typeof manifest.name !== 'string' || names.has(manifest.name)) throw new Error('ambiguous workspace manifest');
    manifests.set(workspace, manifest);
    names.set(manifest.name, workspace);
  }
  const extra = crossWorkspaceInputs[directory] ?? [];
  const workspaceRoots = [directory, ...extra.filter((path) => manifests.has(path))];
  const shared = readdirSync(root).filter(
    (name) => sharedCheckInput(name) || sharedCheckInput(`${name}/`) || /^\.env(?:\.|$)/.test(name),
  );
  return [
    ...new Set([
      ...workspaceRoots.flatMap((path) => checkWorkspaceClosure(path, names, (dir) => manifests.get(dir))),
      ...extra,
      ...sharedPaths,
      ...shared,
    ]),
  ].sort();
}

// Hash the files the admitted process can read, including an overlay and any prepared workspace files Git ignores.
function inputDigest(root: string, paths: string[], outputs: string[]): string {
  const hash = createHash('sha256');
  // Some workspace assertions enumerate tracked source using Git even when the working bytes match.
  hash.update(JSON.stringify(gitList(root, ['ls-files', '--stage', '-z', '--', ...paths])));
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const seen = new Set<string>();
  function visit(path: string) {
    if (seen.has(path) || outputs.includes(path)) return;
    seen.add(path);
    const absolute = join(root, path);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    hash.update(JSON.stringify([path, stat.mode]));
    if (stat.isDirectory()) {
      for (const child of readdirSync(absolute).sort()) {
        if (!skipped.has(child)) visit(`${path}/${child}`);
      }
    } else if (stat.isFile() || stat.isSymbolicLink()) {
      const target = realpathSync(absolute);
      if (!target.startsWith(`${root}/`) || target.split('/').includes('node_modules')) {
        throw new Error('Gate input resolves outside its source checkout');
      }
      const fd = openSync(target, 'r');
      try {
        const before = fstatSync(fd);
        if (!before.isFile()) throw new Error('unsupported Gate input');
        const content = createHash('sha256');
        let count: number;
        while ((count = readSync(fd, buffer)) !== 0) content.update(buffer.subarray(0, count));
        const after = fstatSync(fd);
        if (before.ctimeMs !== after.ctimeMs || before.size !== after.size)
          throw new Error('Gate input changed while hashing');
        hash.update(JSON.stringify([target.slice(root.length), content.digest('hex')]));
      } finally {
        closeSync(fd);
      }
    } else {
      throw new Error('unsupported Gate input');
    }
  }
  for (const path of paths) visit(path);
  return hash.digest('hex');
}

export function openGateWorkspaceResults(root: string, env: Environment, source?: Partial<Source>) {
  if (!source?.run || !source.revision || !source.sourceSha256) return;
  const placement = recognizeCheckHostRun(root);
  if (
    placement.outcome !== 'admitted' ||
    placement.runId !== source.run ||
    root !== join(CHECK_HOST_RUNS_ROOT, source.run)
  )
    return;
  // The workspace command resolves the installed bin link. Bind that binary to the admitted runtime.
  const runtime = repositoryBun(root);
  if (
    runtime.revision !== Bun.revision ||
    realpathSync(join(root, 'node_modules/.bin/bun')) !== realpathSync(runtime.binary)
  )
    return;
  return GateWorkspaceResults.open(root, hostRoot, env, {
    run: source.run,
    revision: source.revision,
    sourceSha256: source.sourceSha256,
  });
}

export function workspaceResultReusable(workspace: Workspace, command: string[]): boolean {
  // Native release and live checks need a current physical result.
  if (workspace.directory === 'apps/web' || command.length !== 3 || command.join(' ') !== 'bun run check') return false;
  const scripts = scriptsWithInputs[workspace.directory];
  if (scripts) return workspace.checkScript === scripts.check;
  if (!reusableCommand([...command, workspace.checkScript])) return false;
  if (workspace.directory === 'services/auth' || workspace.directory === 'services/kernel') {
    return workspace.checkScript === 'bun scripts/check.ts';
  }
  const supported = ['oxfmt --check .', 'bun check --no-script -p tsconfig.json', 'bun test'];
  if (workspace.directory === 'packages/composition' || workspace.directory === 'packages/document') {
    supported.push('bun scripts/schema.ts --check');
  }
  return workspace.checkScript.split(' && ').every((step) => supported.includes(step));
}

function hasKnownScripts(root: string, workspace: Workspace): boolean {
  const { scripts } = JSON.parse(readFileSync(join(root, workspace.directory, 'package.json'), 'utf8'));
  const expected = scriptsWithInputs[workspace.directory] ?? { check: workspace.checkScript };
  return Object.entries(expected).every(
    ([name, recipe]) => scripts?.[name] === recipe && !(`pre${name}` in scripts) && !(`post${name}` in scripts),
  );
}

function authCanReuse(root: string, env: Environment, phase: 'before' | 'after'): boolean {
  if (env.REZICS_SIGN_IN_WALK === '1') return false;
  // Workspace dotenv files can enable the live walk after Gate has started.
  if (readdirSync(join(root, 'apps/auth')).some((name) => /^\.env(?:\.(?!example$).*|$)/.test(name))) return false;
  // Only discard output produced by this check. Existing generated files may affect its initial format/build steps.
  return phase === 'after' || authOutputs.every((path) => !lstatSync(join(root, path), { throwIfNoEntry: false }));
}

function statIdentity(path: string) {
  const { dev, ino, size, ctimeMs } = statSync(path);
  return [path, dev, ino, size, ctimeMs];
}

function browserIdentity(path: string | undefined) {
  if (!path || !isAbsolute(path)) return;
  // Check-host provisioning installs Chromium here. Bind the native binaries as well as the lockfile.
  const files = [
    ...new Bun.Glob('{chromium-*,chromium_headless_shell-*,ffmpeg-*}/**/*').scanSync({ cwd: path }),
  ].sort();
  if (!files.some((file) => /\/chrome-headless-shell$/.test(file))) return;
  return digest(files.map((file) => statIdentity(realpathSync(join(path, file)))));
}

function hostTools(root: string, env: Environment): string {
  const PATH = env.PATH?.split(':')
    .filter((path) => !path.startsWith(`${root}/`))
    .join(':');
  return digest([
    release(),
    ...['sh', 'node', 'git', 'python3', 'docker', 'unshare', 'ip', 'openssl', 'ps', 'go-task', 'task'].map((name) => {
      const found = Bun.which(name, { PATH });
      return [name, found ? statIdentity(realpathSync(found)) : null];
    }),
  ]);
}

export class GateWorkspaceResults {
  static open(root: string, state: string, env: Environment, source: Source): GateWorkspaceResults | undefined {
    const host = env.REMOTE_CHECK_HOST;
    if (!host) return;
    const receipts = join(state, 'receipts');
    secureStat(receipts, true);
    const preparedSha256 = preparedDigest(receipts, host, source);
    if (!preparedSha256) return;
    const runtime = repositoryBun(root);
    // Remove run-specific path components while retaining tool and application settings.
    const environment = Object.entries(env)
      .filter(([name]) => !transientEnv.has(name))
      .sort()
      .map(([name, value]) => [name, value?.replaceAll(root, '<run-root>')]);
    const directory = join(state, 'gate-workspace-results');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    secureStat(directory, true);
    const path = join(directory, 'results.sqlite');
    if (existsSync(path)) secureStat(path, false);
    const db = new Database(path);
    try {
      secureStat(path, false);
      db.exec('PRAGMA busy_timeout = 2000');
      const migration = checkResultsMigration();
      db.transaction(() => {
        const { user_version: version } = db.query('PRAGMA user_version').get() as { user_version: number };
        if (version === migration.version) return;
        if (version !== 0) throw new Error('unsupported Gate result storage');
        db.exec(migration.sql);
        db.exec(`PRAGMA user_version = ${migration.version}`);
      }).immediate();
      return new GateWorkspaceResults(
        root,
        host,
        receipts,
        { ...source, preparedSha256 },
        digest(environment),
        hostTools(root, env),
        runtime,
        env,
        db,
      );
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private readonly results: CheckResults;

  private constructor(
    private readonly root: string,
    private readonly host: string,
    private readonly receipts: string,
    private readonly producer: Producer,
    private readonly environment: string,
    private readonly tools: string,
    private readonly runtime: ReturnType<typeof repositoryBun>,
    private readonly env: Environment,
    private readonly db: Database,
  ) {
    this.results = new CheckResults(db);
  }

  key(workspace: Workspace, command: string[], phase: 'before' | 'after' = 'before'): string | undefined {
    const authPages = workspace.directory === 'apps/auth';
    if (
      !workspaceResultReusable(workspace, command) ||
      !hasKnownScripts(this.root, workspace) ||
      (this.env.KERNEL_CHECK_AFFECTED && workspace.directory === 'services/kernel') ||
      (authPages && !authCanReuse(this.root, this.env, phase))
    )
      return;
    const browser = browserWorkspaces.has(workspace.directory)
      ? browserIdentity(this.env.PLAYWRIGHT_BROWSERS_PATH)
      : '';
    if (browser === undefined) return;
    const source = inputDigest(this.root, scopes(this.root, workspace.directory), authPages ? authOutputs : []);
    return checkResultFingerprint(
      {
        command,
        toolchain: { bun: this.runtime.version, bunRevision: this.runtime.revision },
      },
      workspace.directory,
      [['prepared-workspace-v2', source]],
      [
        ['browser', browser],
        ['environment', this.environment],
        ['host-tools', this.tools],
      ],
    );
  }

  lookup(key: string, workspace: Workspace) {
    const result = this.results.lookup(key);
    if (
      !result ||
      result.unit !== workspace.directory ||
      result.host !== this.host ||
      !Number.isSafeInteger(result.duration) ||
      result.duration < 0
    )
      return;
    const producer = JSON.parse(result.producer) as Producer;
    if (!producer?.preparedSha256 || preparedDigest(this.receipts, this.host, producer) !== producer.preparedSha256)
      return;
    return { durationMs: result.duration, run: producer.run, revision: producer.revision };
  }

  record(key: string, workspace: Workspace, durationMs: number) {
    this.results.record({
      key,
      unit: workspace.directory,
      host: this.host,
      producer: JSON.stringify(this.producer),
      logPath: '',
      duration: Math.round(durationMs),
      passed: true,
      time: Date.now(),
      schemaVersion: CHECK_RESULT_SCHEMA,
    });
  }

  close() {
    this.db.close();
  }
}

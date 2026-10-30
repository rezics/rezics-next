import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import manifest from '../fixtures/definition-historical-construction.json';

const root = resolve(import.meta.dir, '../../../..');
const helperPath = 'packages/definitions/test/support/construction-archive.ts';
const dependencies = ['canonicalize', 'typebox', 'recheck'];
const inside = (directory: string, path: string) => {
  const name = relative(directory, path);
  return name !== '..' && !name.startsWith('../') && !isAbsolute(name);
};

function assertGitless(root: string) {
  for (let directory = realpathSync(root); ; directory = dirname(directory)) {
    if (existsSync(join(directory, '.git'))) throw new Error(`Archive has Git metadata: ${directory}/.git`);
    if (directory === dirname(directory)) break;
  }
}

/** Copy workspace modules, never workspace symlinks. Only installed third-party
 * packages may resolve outside the archive. No Git command produces this tree.
 */
export function createConstructionArchive() {
  const directory = mkdtempSync(join(tmpdir(), 'rezics-construction-archive-'));
  const records: { argv: string[]; stdout: string; stderr: string; exitCode: number }[] = [];
  const helper = join(directory, helperPath);
  const modules = join(directory, 'loaded.jsonl');
  try {
    assertGitless(directory);
    const paths = [
      'packages/definitions/src',
      'packages/definitions/schema',
      'packages/definitions/release/rezics.json',
      'packages/definitions/package.json',
      'packages/filter/src',
      'packages/filter/package.json',
      'packages/definitions/test/publication-construction.test.ts',
      'packages/definitions/test/publication-construction-compatibility.test.ts',
      'packages/definitions/test/support/publication-construction.ts',
      'packages/definitions/test/support/historical-construction.ts',
      helperPath,
      'packages/definitions/test/fixtures/definition-historical-construction.json',
      ...manifest.files.map((file) => ('snapshot' in file ? file.snapshot : file.path)),
    ];
    for (const path of new Set(paths)) {
      const destination = join(directory, path);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(root, path), destination, { recursive: true, dereference: true });
    }
    const installed = join(directory, 'packages/definitions/node_modules');
    mkdirSync(installed, { recursive: true });
    for (const name of dependencies)
      symlinkSync(realpathSync(join(root, 'packages/definitions/node_modules', name)), join(installed, name));
    mkdirSync(join(directory, 'node_modules/@rezics'), { recursive: true });
    symlinkSync(join(directory, 'packages/filter'), join(directory, 'node_modules/@rezics/filter'));
    const denied = join(directory, 'bin');
    mkdirSync(denied);
    writeFileSync(join(denied, 'git'), '#!/bin/sh\necho "Archive Git invocation denied" >&2\nexit 97\n', {
      mode: 0o700,
    });
    writeFileSync(modules, '');
    return {
      helper,
      assertGitless: () => assertGitless(directory),
      loadedModules: () =>
        readFileSync(modules, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string),
      async run(args: string[]) {
        const argv = [process.execPath, '--preload', helper, ...args];
        const child = Bun.spawn(argv, {
          cwd: join(directory, 'packages/definitions'),
          env: {
            ...process.env,
            // Drop inherited runtime injection; this archive has its own guard.
            BUN_OPTIONS: '',
            NODE_OPTIONS: '',
            GIT_DIR: undefined,
            GIT_WORK_TREE: undefined,
            PATH: denied,
            REZICS_CONSTRUCTION_ARCHIVE: directory,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        const record = { argv, stdout, stderr, exitCode };
        records.push(record);
        return record;
      },
      preserve(error?: unknown) {
        const evidence = join(root, '.temp/publication-construction', `archive-${process.pid}`);
        mkdirSync(evidence, { recursive: true });
        writeFileSync(join(evidence, 'commands.json'), JSON.stringify(records, null, 2));
        cpSync(modules, join(evidence, 'loaded.jsonl'));
        if (error) {
          writeFileSync(join(evidence, 'failure.txt'), String(error));
          cpSync(directory, join(evidence, 'checkout'), {
            recursive: true,
            dereference: false,
            filter: (path) => !path.endsWith('/node_modules'),
          });
        }
        console.log('construction archive receipts', JSON.stringify(records));
        console.log(`construction archive evidence ${evidence}`);
      },
      close: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function installArchiveGuard() {
  assertGitless(root);
  const deny = () => {
    throw new Error('Archive Git/network/process invocation denied');
  };
  const spawn = Bun.spawn.bind(Bun);
  // The sole permitted subprocess is the existing real instrumentation child.
  // Inject this preload explicitly so the nested runtime has the same boundary.
  Bun.spawn = ((argv: string[], options: object) => {
    if (
      argv.length !== 3 ||
      argv[0] !== process.execPath ||
      argv[1] !== join(root, 'packages/definitions/test/support/publication-construction.ts') ||
      argv[2] !== '--probe'
    )
      return deny();
    return spawn([argv[0], '--preload', import.meta.path, ...argv.slice(1)], options);
  }) as typeof Bun.spawn;
  Bun.spawnSync = deny;
  Bun.$ = deny as unknown as typeof Bun.$;
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const)
    Object.defineProperty(childProcess, name, { value: deny, configurable: true });
  net.Socket.prototype.connect = deny;
  tls.connect = deny;
  dgram.createSocket = deny;
  globalThis.fetch = Object.assign(deny, { preconnect: deny });
  globalThis.WebSocket = deny as unknown as typeof WebSocket;
  Bun.connect = deny;
  Bun.listen = deny;
  Bun.udpSocket = deny;
  syncBuiltinESMExports();
  const external = dependencies.map((name) => realpathSync(join(root, 'packages/definitions/node_modules', name)));
  Bun.plugin({
    name: 'construction-archive-boundary',
    setup(build) {
      build.onLoad({ filter: /\.(?:[cm]?[jt]s|json)$/ }, ({ path }) => {
        const actual = realpathSync(path);
        if (!inside(root, actual) && !external.some((directory) => inside(directory, actual)))
          throw new Error(`Module escaped construction archive: ${path} -> ${actual}`);
        if (inside(root, actual))
          appendFileSync(join(root, 'loaded.jsonl'), `${JSON.stringify(relative(root, actual))}\n`);
        return {
          contents: readFileSync(actual),
          loader: path.endsWith('.json') ? 'json' : /\.[cm]?ts$/.test(path) ? 'ts' : 'js',
        };
      });
    },
  });
}

if (process.env.REZICS_CONSTRUCTION_ARCHIVE === root) installArchiveGuard();

if (import.meta.main && process.argv.includes('--identities')) {
  // Confirm the preloaded boundary is active, including absolute executable
  // paths and low-level sockets, before exercising any historical module.
  for (const attempt of [
    () => Bun.spawnSync(['git', 'show', manifest.revision]),
    () => childProcess.spawnSync('/usr/bin/git', ['show', manifest.revision]),
    () => fetch('https://archive.invalid'),
    () => new net.Socket().connect(443, 'archive.invalid'),
  ]) {
    let message = '';
    try {
      attempt();
    } catch (error) {
      message = (error as Error).message;
    }
    if (message !== 'Archive Git/network/process invocation denied')
      throw new Error(`Archive runtime boundary inactive: ${message}`);
  }
  const { historicalConstructionSources } = await import('./historical-construction.ts');
  historicalConstructionSources(true);
  let rejectedMutations = 0;
  for (const file of manifest.files) {
    const path = join(root, 'snapshot' in file ? file.snapshot : file.path);
    const original = readFileSync(path);
    const { sha256, gitBlob } = file;
    const changed = Buffer.concat([original, Buffer.from('\n/* archive integrity witness */\n')]);
    try {
      writeFileSync(path, changed);
      // Exercise each independent digest guard while the other digest matches
      // the damaged bytes. Neither mismatch may silently bless a fixture.
      for (const guard of ['sha256', 'gitBlob'] as const) {
        file.sha256 = guard === 'sha256' ? sha256 : createHash('sha256').update(changed).digest('hex');
        file.gitBlob =
          guard === 'gitBlob'
            ? gitBlob
            : createHash('sha1').update(`blob ${changed.length}\0`).update(changed).digest('hex');
        let message = '';
        try {
          historicalConstructionSources(true);
        } catch (error) {
          message = (error as Error).message;
        }
        if (message !== `Historical source identity mismatch: ${file.path}`)
          throw new Error(`Missing ${guard} identity rejection for ${file.path}: ${message}`);
        rejectedMutations++;
      }
    } finally {
      writeFileSync(path, original);
      Object.assign(file, { sha256, gitBlob });
    }
  }
  historicalConstructionSources(true);
  console.log(JSON.stringify({ revision: manifest.revision, identities: manifest.files.length, rejectedMutations }));
}

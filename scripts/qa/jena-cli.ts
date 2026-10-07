import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { loadDockerEnvironment } from '../load/docker-env.ts';
import { captureFusekiPlan } from '../load/fuseki-plan.ts';
import { fusekiImageFromCompose } from '../load/image.ts';

const root = resolve(import.meta.dir, '../..');
export const jenaContainerName = 'rezics-jena-cli';
export const jenaScratchGraph = 'https://rezics.com/jena-cli/scratch';
const deadlineMs = 60_000;
const outputBytes = 1_048_576;
const memory = '768m';
const heap = '384m';
const sleepSeconds = '90';
const reviewedQuery = 'services/main/src/modules/query/templates/work-versions.rq';
const reviewedFixture = 'services/main/src/modules/query/templates/work-versions.fixture.json';
const scratchSource = 'tests/fixtures/jena-cli/scratch.trig';
const assemblers = [
  'infra/jena/fuseki-text.ttl',
  'infra/jena/fuseki-text-qa.ttl',
  'infra/jena/fuseki-text-qa-raw.ttl',
  'infra/jena/fuseki-text-quickstart.ttl',
];

export interface JenaCommandBounds {
  timeoutMs: number;
  maxOutputBytes: number;
}
export interface JenaCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
}
export interface JenaCheckOptions {
  directory?: string;
  dockerEnv?: NodeJS.ProcessEnv;
  imagePresent?: (image: string) => boolean;
  run?: (command: string[], bounds: JenaCommandBounds) => JenaCommandResult;
  maxOutputBytes?: number;
  deadlineMs?: number;
  /** Remove the named container if this process is signalled while Java is blocked. */
  watchSignals?: boolean;
}
export interface JenaCheckEvidence {
  image: string;
  jenaVersion: string;
  container: string;
  mount: string;
  riotFiles: number;
  query: {
    source: string;
    fixture: string;
    fixtureSha256: string;
    planFile: string;
    queryDigest: string;
  };
  scratchGraph: string;
  defaultCount: number;
  namedCount: number;
  statsOpt: 'absent';
  basis: 'tdbstats stdout for one scratch dataset; not installed as stats.opt and not a live store measurement';
}

function boundsOf(options: JenaCheckOptions): { deadlineMs: number; maxOutputBytes: number } {
  const deadline = options.deadlineMs ?? deadlineMs;
  const output = options.maxOutputBytes ?? outputBytes;
  if (!Number.isFinite(deadline) || deadline <= 0 || deadline > deadlineMs)
    throw new Error('Jena CLI deadline must be a positive bound of at most 60 seconds');
  if (!Number.isFinite(output) || output <= 0 || output > outputBytes)
    throw new Error('Jena CLI output bound must be at most 1 MiB');
  return { deadlineMs: deadline, maxOutputBytes: output };
}

function scratchDirectory(requested?: string): string {
  const directory = resolve(root, requested ?? '.temp/jena-cli');
  const local = relative(root, directory);
  if (
    local.startsWith('..') ||
    !local.startsWith('.temp/') ||
    local.split(/[\\/]/).includes('vault')
  )
    throw new Error('Jena CLI artifacts must stay under .temp and outside the vault');
  return directory;
}

function checkoutFile(source: string): string {
  const file = resolve(root, source);
  const local = relative(root, file);
  if (local.startsWith('..') || local.split(/[\\/]/).includes('vault'))
    throw new Error('Jena CLI can read only checkout artifacts outside the vault');
  return file;
}

function turtleFiles(directory: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.ttl')) found.push(path);
    }
  };
  walk(directory);
  return found.sort();
}

function stageCopy(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

function realRun(
  command: string[],
  env: NodeJS.ProcessEnv,
  bounds: JenaCommandBounds,
): JenaCommandResult {
  const result = spawnSync(command[0]!, command.slice(1), {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: bounds.timeoutMs,
    maxBuffer: bounds.maxOutputBytes,
    killSignal: 'SIGKILL',
  });
  const error = result.error as NodeJS.ErrnoException | undefined;
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
    throw new Error('Jena CLI output exceeded 1 MiB');
  if (error?.code === 'ETIMEDOUT' || result.signal) throw new Error('Jena CLI deadline exceeded');
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    signal: result.signal,
  };
}

function countOf(stats: string): number {
  const match = stats.match(/\(count (\d+)\)/);
  if (!match) throw new Error('TDB2 statistics did not report a count');
  return Number(match[1]);
}

function tail(text: string): string {
  return text.trim().slice(-500);
}

/** The detached container command. TDB2 lives on a container tmpfs, never a host dataset. */
export function jenaContainerArguments(image: string, directory: string): string[] {
  return [
    'docker',
    'run',
    '-d',
    '--name',
    jenaContainerName,
    '--network',
    'none',
    '--memory',
    memory,
    '--memory-swap',
    memory,
    '--pids-limit',
    '256',
    '--read-only',
    '--user',
    '10001:10001',
    '--tmpfs',
    '/tmp:rw,nosuid,size=32m,mode=1777',
    '--tmpfs',
    '/tdb:rw,nosuid,size=64m,mode=1777',
    '--volume',
    `${directory}:/artifacts:ro,Z`,
    '--entrypoint',
    '/bin/sleep',
    image,
    sleepSeconds,
  ];
}

function useContainer<T>(
  options: JenaCheckOptions,
  body: (ctx: {
    directory: string;
    image: { image: string; jenaVersion: string };
    java: (args: string[]) => JenaCommandResult;
    exec: (args: string[]) => JenaCommandResult;
    save: (name: string, result: JenaCommandResult) => void;
  }) => T,
): T {
  const limits = boundsOf(options);
  const compose = readFileSync(join(root, 'infra/dev/compose.yaml'), 'utf8');
  const image = fusekiImageFromCompose(compose);
  if (options.imagePresent) {
    if (!options.imagePresent(image.image))
      throw new Error(`Pinned Fuseki image is not present: ${image.image}`);
  }
  const env = options.dockerEnv ?? loadDockerEnvironment();
  if (!options.imagePresent) {
    const inspected = realRun(
      ['docker', 'image', 'inspect', image.image, '--format', '{{.Id}}'],
      env,
      { timeoutMs: 10_000, maxOutputBytes: 4096 },
    );
    if (inspected.status !== 0 || !inspected.stdout.trim().startsWith('sha256:'))
      throw new Error(`Pinned Fuseki image is not present: ${image.image}`);
  }
  const directory = scratchDirectory(options.directory);
  mkdirSync(directory, { recursive: true });
  // spawnSync does not run JavaScript signal handlers, so a shell in this process
  // group removes the container when the command is cancelled mid-Java.
  const watchdog = options.watchSignals
    ? spawn(
        'sh',
        [
          '-c',
          `trap '' HUP; trap 'setsid docker rm -f ${jenaContainerName} >/dev/null 2>&1; exit 0' TERM INT; while :; do sleep 1; done`,
        ],
        { cwd: root, env, stdio: 'ignore' },
      )
    : undefined;
  const stopWatchdog = () => {
    const pid = watchdog?.pid;
    if (!watchdog || watchdog.exitCode !== null || pid === undefined) return;
    watchdog.kill('SIGTERM');
    spawnSync(
      'sh',
      [
        '-c',
        `i=0; while kill -0 ${pid} 2>/dev/null && [ "$i" -lt 150 ]; do i=$((i+1)); sleep 0.1; done`,
      ],
      { timeout: 20_000 },
    );
  };
  const started = Date.now();
  const run = (command: string[], timeoutMs: number): JenaCommandResult => {
    if (command.some((part) => part === 'pull' || part === 'build'))
      throw new Error('Jena CLI does not build or pull an image');
    const elapsed = Date.now() - started;
    if (elapsed >= limits.deadlineMs) throw new Error('Jena CLI deadline exceeded');
    const bounds = {
      timeoutMs: Math.min(timeoutMs, limits.deadlineMs - elapsed),
      maxOutputBytes: limits.maxOutputBytes,
    };
    const result = options.run ? options.run(command, bounds) : realRun(command, env, bounds);
    const bytes = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
    if (bytes > limits.maxOutputBytes) throw new Error('Jena CLI output exceeded 1 MiB');
    if (result.status === null || result.signal) throw new Error('Jena CLI deadline exceeded');
    return result;
  };
  const requireOk = (result: JenaCommandResult, label: string) => {
    if (result.status !== 0)
      throw new Error(
        `${label} failed (${result.status}): ${tail(result.stderr || result.stdout)}`,
      );
  };
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    stopWatchdog();
    const removed = options.run
      ? options.run(['docker', 'rm', '-f', jenaContainerName], {
          timeoutMs: 15_000,
          maxOutputBytes: 4096,
        })
      : realRun(['docker', 'rm', '-f', jenaContainerName], env, {
          timeoutMs: 15_000,
          maxOutputBytes: 4096,
        });
    if (removed.status !== 0) throw new Error(`Could not remove ${jenaContainerName}`);
  };
  let failure: unknown;
  try {
    requireOk(
      run(['docker', 'rm', '-f', jenaContainerName], 15_000),
      'Removing a previous Jena CLI container',
    );
    requireOk(
      run(jenaContainerArguments(image.image, directory), 20_000),
      'Starting the pinned Jena CLI container',
    );
    const jar = `/opt/apache-jena-fuseki-${image.jenaVersion}/fuseki-server.jar`;
    const exec = (args: string[]) => run(['docker', 'exec', jenaContainerName, ...args], 20_000);
    const java = (args: string[]) => exec(['java', `-Xmx${heap}`, '-cp', jar, ...args]);
    const save = (name: string, result: JenaCommandResult) => {
      writeFileSync(join(directory, `${name}.stdout`), result.stdout);
      writeFileSync(join(directory, `${name}.stderr`), result.stderr);
    };
    return body({ directory, image, java, exec, save });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      cleanup();
    } catch (error) {
      if (failure === undefined) throw error;
    }
  }
}

function stageInputs(directory: string): { riot: string[]; fixtureSha256: string } {
  const stage = join(directory, 'stage');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const copyTree = (from: string, prefix: string) => {
    const files = turtleFiles(checkoutFile(from));
    if (!files.length) throw new Error(`No Turtle in ${from}`);
    return files.map((file) => {
      const target = join(stage, prefix, relative(checkoutFile(from), file));
      stageCopy(file, target);
      return `/artifacts/stage/${prefix}/${relative(checkoutFile(from), file).split('\\').join('/')}`;
    });
  };
  const authored = copyTree('model/definitions', 'authored');
  const shapes = copyTree('generated/model/shapes', 'shapes');
  const assemblerPaths = assemblers.map((source) => {
    const name = source.split('/').at(-1)!;
    stageCopy(checkoutFile(source), join(stage, 'assemblers', name));
    return `/artifacts/stage/assemblers/${name}`;
  });
  stageCopy(checkoutFile(scratchSource), join(stage, 'scratch.trig'));
  const fixture = JSON.parse(readFileSync(checkoutFile(reviewedFixture), 'utf8')) as {
    parameters?: unknown;
    dataset?: unknown;
  };
  if (
    !fixture.parameters ||
    typeof fixture.dataset !== 'string' ||
    !fixture.dataset.startsWith('@prefix ')
  )
    throw new Error('Reviewed work-versions fixture is missing its fixed dataset');
  writeFileSync(
    join(stage, 'work-versions.fixture.trig'),
    fixture.dataset.endsWith('\n') ? fixture.dataset : `${fixture.dataset}\n`,
  );
  const riot = [
    ...authored,
    ...shapes,
    ...assemblerPaths,
    '/artifacts/stage/scratch.trig',
    '/artifacts/stage/work-versions.fixture.trig',
  ];
  if (riot.length > 512) throw new Error('Jena CLI file set exceeds 512');
  return {
    riot,
    fixtureSha256: createHash('sha256')
      .update(readFileSync(checkoutFile(reviewedFixture)))
      .digest('hex'),
  };
}

/** Parse or validate one checkout file. A non-zero status is the tool's refusal, with its output retained. */
export function jenaRefusal(
  kind: 'turtle' | 'query',
  source: string,
  options: JenaCheckOptions = {},
): { status: number; output: string } {
  const file = resolve(root, source);
  const local = relative(root, file);
  if (
    local.startsWith('..') ||
    (kind === 'turtle' ? !local.endsWith('.ttl') : !local.endsWith('.rq'))
  )
    throw new Error('Jena CLI can refuse only a checkout Turtle or query file');
  return useContainer(options, ({ directory, java, save }) => {
    const stage = join(directory, 'stage');
    rmSync(stage, { recursive: true, force: true });
    const name = kind === 'turtle' ? 'input.ttl' : 'input.rq';
    stageCopy(file, join(stage, name));
    const result = java(
      kind === 'turtle'
        ? ['riotcmd.riot', '--validate', `/artifacts/stage/${name}`]
        : ['arq.qparse', '--query', `/artifacts/stage/${name}`],
    );
    save(kind === 'turtle' ? 'riot-refusal' : 'query-refusal', result);
    return { status: result.status ?? 1, output: result.stdout + result.stderr };
  });
}

/** Validate pinned artifacts, parse the reviewed query, and record scratch graph statistics. */
export function jenaCheck(options: JenaCheckOptions = {}): JenaCheckEvidence {
  return useContainer(options, ({ directory, image, java, exec, save }) => {
    const inputs = stageInputs(directory);
    const riot = java(['riotcmd.riot', '--quiet', '--validate', ...inputs.riot]);
    save('riot', riot);
    if (riot.status !== 0)
      throw new Error(`RIOT rejected Turtle or an assembler: ${tail(riot.stdout || riot.stderr)}`);
    const sparql = readFileSync(checkoutFile(reviewedQuery), 'utf8');
    const plan = captureFusekiPlan(sparql, {
      label: 'work-versions',
      directory,
      image,
      run: (command) => {
        const at = command.lastIndexOf(image.image);
        if (at < 0) throw new Error('Reviewed query capture did not use the pinned image');
        return exec(['java', `-Xmx${heap}`, ...command.slice(at + 1)]);
      },
    });
    const loaded = java([
      'tdb2.tdbloader',
      '--loader=basic',
      '--loc=/tdb',
      '/artifacts/stage/scratch.trig',
    ]);
    save('loader', loaded);
    if (loaded.status !== 0)
      throw new Error(
        `TDB2 loader rejected the scratch TriG: ${tail(loaded.stderr || loaded.stdout)}`,
      );
    const defaults = java(['tdb2.tdbstats', '--loc=/tdb']);
    save('default-stats', defaults);
    if (defaults.status !== 0) throw new Error('Default-graph statistics failed');
    const named = java(['tdb2.tdbstats', '--loc=/tdb', `--graph=${jenaScratchGraph}`]);
    save('named-stats', named);
    if (named.status !== 0) throw new Error('Named-graph statistics failed');
    const defaultCount = countOf(defaults.stdout);
    const namedCount = countOf(named.stdout);
    if (defaultCount === namedCount || !named.stdout.includes('https://rezics.com/jena-cli/extra'))
      throw new Error(
        'Scratch statistics did not distinguish the named graph from the default graph',
      );
    const optimizer = exec(['find', '/tdb', '-name', 'stats.opt', '-print']);
    save('stats-opt', optimizer);
    if (optimizer.status !== 0 || optimizer.stdout.trim() !== '')
      throw new Error(
        'tdbstats stdout was not left as stdout; stats.opt appeared in the scratch dataset',
      );
    const evidence: JenaCheckEvidence = {
      image: image.image,
      jenaVersion: image.jenaVersion,
      container: jenaContainerName,
      mount: relative(root, directory),
      riotFiles: inputs.riot.length,
      query: {
        source: reviewedQuery,
        fixture: reviewedFixture,
        fixtureSha256: inputs.fixtureSha256,
        planFile: plan.planFile,
        queryDigest: plan.queryDigest,
      },
      scratchGraph: jenaScratchGraph,
      defaultCount,
      namedCount,
      statsOpt: 'absent',
      basis:
        'tdbstats stdout for one scratch dataset; not installed as stats.opt and not a live store measurement',
    };
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    return evidence;
  });
}

if (import.meta.main) {
  if (process.argv.length > 2) {
    console.error('task jena:check accepts no dataset or path arguments');
    process.exit(2);
  }
  try {
    const evidence = jenaCheck({ watchSignals: true });
    console.log(`.temp/jena-cli/evidence.json ${evidence.defaultCount} ${evidence.namedCount}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

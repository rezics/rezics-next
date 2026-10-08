import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../../..');
const sources = import.meta.dir;

/** The Fuseki image pinned for the dev and QA stacks; its class path is the Jena the product runs. */
export function fusekiImage() {
  const image = /^\s*image:\s*(rezics\/fuseki:\S+)$/m.exec(
    readFileSync(join(root, 'infra/dev/compose.yaml'), 'utf8'),
  )?.[1];
  if (!image) throw new Error('infra/dev/compose.yaml pins no rezics/fuseki image');
  return image;
}

/** The JDK image that builds the command module; the Fuseki image carries only a JRE. */
function builderImage() {
  const image = /^FROM (\S+) AS module$/m.exec(
    readFileSync(join(root, 'infra/jena/Dockerfile'), 'utf8'),
  )?.[1];
  if (!image) throw new Error('infra/jena/Dockerfile pins no native builder');
  return image;
}

function docker(args: string[], timeout = 300_000) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

/** Copies the server jar out of the Fuseki image once per image id. */
function serverJar() {
  const image = fusekiImage();
  const id = docker(['image', 'inspect', '--format', '{{.Id}}', image]).trim().replace(/^sha256:/, '').slice(0, 12);
  const cache = join(root, '.temp/tdb2-integrity/jars', id);
  const jar = join(cache, 'fuseki-server.jar');
  if (!existsSync(jar)) {
    mkdirSync(cache, { recursive: true });
    const container = docker(['create', image]).trim();
    try {
      docker(['cp', `${container}:/opt/apache-jena-fuseki-6.2.0/fuseki-server.jar`, jar]);
    } finally {
      docker(['rm', '-f', container]);
    }
  }
  return cache;
}

/**
 * Runs a class from this directory against `database` (the folder that holds Data-NNNN).
 * Stdout is returned; a non-zero exit is returned, not thrown, so callers can read a damage report.
 */
export function runJava(className: string, args: string[], database: string, memory = '6g') {
  const jars = serverJar();
  const script = [
    'set -eu',
    'mkdir /tmp/classes',
    'javac -nowarn -cp /jars/fuseki-server.jar -d /tmp/classes /sources/*.java',
    `exec java -Xmx${memory} -cp /jars/fuseki-server.jar:/tmp/classes ${className} "$@"`,
  ].join('\n');
  const result = spawnSync(
    'docker',
    [
      'run', '--rm', '--entrypoint', 'sh', '--user', `${process.getuid!()}:${process.getgid!()}`,
      '--volume', `${jars}:/jars:ro`, '--volume', `${sources}:/sources:ro`,
      '--volume', `${resolve(database)}:/database`,
      builderImage(), '-c', script, 'tdb2-integrity', ...args,
    ],
    { encoding: 'utf8', timeout: 900_000, maxBuffer: 64 * 1024 * 1024 },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function lastJsonLine<T = Record<string, unknown>>(stdout: string): T {
  const line = stdout.trim().split('\n').filter((entry) => entry.startsWith('{')).pop();
  if (!line) throw new Error(`no JSON result in:\n${stdout}`);
  return JSON.parse(line) as T;
}

export function freshDirectory(label: string) {
  const directory = join(root, '.temp/tdb2-integrity', `${label}-${crypto.randomUUID().slice(0, 8)}`);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  return directory;
}

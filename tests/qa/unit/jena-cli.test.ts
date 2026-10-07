import { expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fusekiImageFromCompose } from '../../../scripts/load/image.ts';
import {
  jenaCheck,
  jenaContainerArguments,
  jenaContainerName,
  jenaRefusal,
  jenaScratchGraph,
  type JenaCommandResult,
} from '../../../scripts/qa/jena-cli.ts';

const root = resolve(import.meta.dir, '../../..');
const image = fusekiImageFromCompose(
  readFileSync(join(root, 'infra/dev/compose.yaml'), 'utf8'),
).image;
const ok = (stdout = ''): JenaCommandResult => ({ status: 0, stdout, stderr: '', signal: null });

function containerExists(): boolean {
  return spawnSync('docker', ['inspect', jenaContainerName], { encoding: 'utf8' }).status === 0;
}

test('the pinned container mounts only the scratch directory and cannot raise its bounds', () => {
  const directory = join(root, '.temp/jena-cli');
  const args = jenaContainerArguments(image, directory);
  expect(args).toContain(jenaContainerName);
  expect(jenaContainerName).toBe('rezics-jena-cli');
  expect(args).toContain('--network');
  expect(args).toContain('none');
  expect(args).toContain('--memory');
  expect(args).toContain('768m');
  expect(args).toContain('--read-only');
  expect(args[args.indexOf('--volume') + 1]).toBe(`${directory}:/artifacts:ro,Z`);
  expect(args.some((part) => part === root || part.startsWith(`${root}:`))).toBe(false);
  expect(args.some((part) => part.includes('/.temp/vault'))).toBe(false);
  expect(args).not.toContain('pull');
  expect(args).not.toContain('build');
  expect(Number(args.at(-1))).toBeLessThanOrEqual(120);
  const source = readFileSync(join(root, 'scripts/qa/jena-cli.ts'), 'utf8');
  expect(source).not.toContain('docker pull');
  expect(source).not.toContain('docker build');
  expect(() =>
    jenaCheck({
      directory: '.temp/vault/jena',
      dockerEnv: process.env,
      imagePresent: () => true,
      run: () => {
        throw new Error('ran');
      },
    }),
  ).toThrow(/vault/);
  expect(() =>
    jenaCheck({
      directory: 'model/definitions',
      dockerEnv: process.env,
      imagePresent: () => true,
      run: () => {
        throw new Error('ran');
      },
    }),
  ).toThrow(/\.temp/);
  expect(() =>
    jenaRefusal('turtle', '/etc/passwd', {
      imagePresent: () => {
        throw new Error('inspected');
      },
    }),
  ).toThrow(/checkout/);
  const refused = spawnSync('bun', ['scripts/qa/jena-cli.ts', '--loc', '/tmp/live'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
  });
  expect(refused.status).toBe(2);
  expect(refused.stderr).toContain('no dataset or path arguments');
});

test('a missing pinned image stops before any container or pull', () => {
  let ran = false;
  expect(() =>
    jenaCheck({
      imagePresent: () => false,
      run: () => {
        ran = true;
        return ok();
      },
    }),
  ).toThrow(`Pinned Fuseki image is not present: ${image}`);
  expect(ran).toBe(false);
});

test('a command deadline or oversized output still removes the named container', () => {
  const seen: string[][] = [];
  const run = (
    command: string[],
    bounds: { timeoutMs: number; maxOutputBytes: number },
  ): JenaCommandResult => {
    seen.push(command);
    expect(bounds.timeoutMs).toBeLessThanOrEqual(60_000);
    expect(bounds.maxOutputBytes).toBeLessThanOrEqual(1_048_576);
    if (command[1] === 'rm') return ok();
    return { status: null, stdout: '', stderr: '', signal: 'SIGTERM' };
  };
  expect(() =>
    jenaCheck({
      directory: '.temp/jena-cli-deadline',
      dockerEnv: process.env,
      imagePresent: () => true,
      run,
    }),
  ).toThrow(/deadline exceeded/);
  const started = seen.find((command) => command[1] === 'run');
  expect(started?.slice(0, 4)).toEqual(['docker', 'run', '-d', '--name']);
  expect(started).toContain('768m');
  expect(started?.some((part) => part.endsWith('/.temp/jena-cli-deadline:/artifacts:ro,Z'))).toBe(
    true,
  );
  expect(seen.some((command) => command.includes('pull') || command.includes('build'))).toBe(false);
  expect(seen.at(-1)?.slice(0, 3)).toEqual(['docker', 'rm', '-f']);
  expect(seen.at(-1)).toContain(jenaContainerName);

  const output: string[][] = [];
  expect(() =>
    jenaCheck({
      directory: '.temp/jena-cli-output',
      dockerEnv: process.env,
      imagePresent: () => true,
      maxOutputBytes: 64,
      run: (command) => {
        output.push(command);
        if (command[1] === 'rm') return ok();
        if (command[1] === 'run') return ok('container\n');
        return ok('x'.repeat(65));
      },
    }),
  ).toThrow(/output exceeded 1 MiB/);
  expect(output.at(-1)?.slice(0, 3)).toEqual(['docker', 'rm', '-f']);
});

test('the pinned CLI refuses malformed Turtle and queries, separates scratch statistics, and removes its container on cancellation', async () => {
  const turtle = jenaRefusal('turtle', 'tests/fixtures/jena-cli/malformed.ttl');
  expect(turtle.status).not.toBe(0);
  expect(turtle.output).toContain('Broken token (newline in string)');
  expect(containerExists()).toBe(false);

  const query = jenaRefusal('query', 'tests/fixtures/jena-cli/malformed.rq');
  expect(query.status).not.toBe(0);
  expect(query.output).toContain('Encountered "<EOF>"');
  expect(containerExists()).toBe(false);

  const check = spawnSync('task', ['jena:check'], { cwd: root, encoding: 'utf8', timeout: 90_000 });
  if (check.status !== 0) throw new Error(check.stdout + check.stderr);
  const evidence = JSON.parse(readFileSync(join(root, '.temp/jena-cli/evidence.json'), 'utf8')) as {
    image: string;
    mount: string;
    riotFiles: number;
    defaultCount: number;
    namedCount: number;
    scratchGraph: string;
    statsOpt: string;
    container: string;
    query: {
      source: string;
      fixture: string;
      fixtureSha256: string;
      planFile: string;
      queryDigest: string;
    };
    basis: string;
  };
  expect(evidence.image).toBe(image);
  expect(evidence.mount).toBe('.temp/jena-cli');
  expect(evidence.container).toBe(jenaContainerName);
  expect(evidence.riotFiles).toBeGreaterThan(100);
  expect(evidence.scratchGraph).toBe(jenaScratchGraph);
  expect(evidence.defaultCount).toBe(1);
  expect(evidence.namedCount).toBe(2);
  expect(evidence.statsOpt).toBe('absent');
  expect(evidence.basis).toContain('not installed as stats.opt');
  expect(evidence.query.source).toBe('services/main/src/modules/query/templates/work-versions.rq');
  expect(evidence.query.fixture).toBe(
    'services/main/src/modules/query/templates/work-versions.fixture.json',
  );
  const fixture = readFileSync(join(root, evidence.query.fixture));
  const sparql = readFileSync(join(root, evidence.query.source));
  expect(evidence.query.fixtureSha256).toBe(createHash('sha256').update(fixture).digest('hex'));
  expect(evidence.query.queryDigest).toBe(createHash('sha256').update(sparql).digest('hex'));
  const plan = readFileSync(join(root, '.temp/jena-cli', evidence.query.planFile), 'utf8');
  expect(plan).toContain('text-variant');
  const named = readFileSync(join(root, '.temp/jena-cli/named-stats.stdout'), 'utf8');
  const defaults = readFileSync(join(root, '.temp/jena-cli/default-stats.stdout'), 'utf8');
  expect(named).toContain('(count 2)');
  expect(named).toContain('https://rezics.com/jena-cli/extra');
  expect(defaults).toContain('(count 1)');
  expect(defaults).not.toContain('https://rezics.com/jena-cli/extra');
  expect(readFileSync(join(root, '.temp/jena-cli/stats-opt.stdout'), 'utf8')).toBe('');
  expect(containerExists()).toBe(false);

  const child = spawn('bun', ['scripts/qa/jena-cli.ts'], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
  });
  try {
    let seen = false;
    for (let attempt = 0; attempt < 100 && !seen; attempt += 1) {
      seen = containerExists();
      if (!seen) await Bun.sleep(200);
    }
    expect(seen).toBe(true);
    process.kill(-child.pid!, 'SIGTERM');
    const code = await new Promise<number>((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Jena CLI did not exit after cancellation')),
        20_000,
      );
      child.once('exit', (status, signal) => {
        clearTimeout(timer);
        done(signal ? 143 : (status ?? 1));
      });
    });
    expect(code).not.toBe(0);
    let gone = false;
    for (let attempt = 0; attempt < 50 && !gone; attempt += 1) {
      gone = !containerExists();
      if (!gone) await Bun.sleep(200);
    }
    expect(gone).toBe(true);
  } finally {
    if (containerExists())
      spawnSync('docker', ['rm', '-f', jenaContainerName], { timeout: 15_000 });
  }
}, 180_000);

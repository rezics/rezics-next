import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const imageDirectory = resolve(directory, 'db/search/opensearch');
const container = 'rezics-search-dev';
const volume = 'rezics-search-dev';
const port = Number(process.env.KERNEL_SEARCH_PORT ?? '59200');

function command(program: string, args: string[], cwd = directory): string {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

function docker(args: string[], cwd = directory): string {
  return command('docker', args, cwd);
}

export function buildSearchImage(): string {
  const dockerfile = resolve(imageDirectory, 'Dockerfile');
  const hash = createHash('sha256').update(readFileSync(dockerfile)).digest('hex').slice(0, 12);
  const image = `rezics-search:${hash}`;
  const existing = spawnSync('docker', ['image', 'inspect', image], {
    cwd: imageDirectory,
    encoding: 'utf8',
    stdio: 'ignore',
  });
  if (existing.error) throw existing.error;
  if (existing.status === 0) return image;
  docker(['build', '--tag', image, '.'], imageDirectory);
  return image;
}

export async function waitForSearch(url: string, containerName: string, timeoutMs = 120_000): Promise<void> {
  const endpoint = new URL('/_cluster/health?wait_for_status=yellow&timeout=2s', url);
  const deadline = Date.now() + timeoutMs;
  let lastFailure = 'no response';

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(Math.min(2500, remainingMs)) });
      if (!response.ok) {
        lastFailure = `HTTP ${response.status}`;
      } else {
        const health = (await response.json()) as { status?: string; timed_out?: boolean };
        if (!health.timed_out && (health.status === 'yellow' || health.status === 'green')) return;
        lastFailure = `cluster status ${health.status ?? 'unknown'}`;
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }

    const sleepMs = Math.min(500, deadline - Date.now());
    if (sleepMs > 0) await Bun.sleep(sleepMs);
  }

  let logs: string;
  try {
    logs = docker(['logs', '--tail', '80', containerName]);
  } catch (error) {
    logs = error instanceof Error ? error.message : String(error);
  }
  throw new Error(
    `OpenSearch node did not reach yellow or green health within ${timeoutMs} ms (${lastFailure}).\n${logs}`,
  );
}

/** A check running on a development host keeps its containers inside that host's capped slice. */
export function cgroupArgs(): string[] {
  return process.env.KERNEL_CHECK_ON_REMOTE ? ['--cgroup-parent=rezics-check.slice'] : [];
}

export function searchRunArgs(image: string): string[] {
  return [
    'run',
    '-d',
    ...cgroupArgs(),
    '--name',
    container,
    '-p',
    `127.0.0.1:${port}:9200`,
    '-v',
    `${volume}:/usr/share/opensearch/data`,
    '-e',
    'discovery.type=single-node',
    '-e',
    'DISABLE_SECURITY_PLUGIN=true',
    '-e',
    'DISABLE_INSTALL_DEMO_CONFIG=true',
    '-e',
    'OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m',
    image,
  ];
}

function developmentEnv(existing: string, url: string): string {
  const lines = existing.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let hasOpenSearchUrl = false;
  const updated = lines.map((line) => {
    if (!line.startsWith('OPENSEARCH_URL=')) return line;
    hasOpenSearchUrl = true;
    return `OPENSEARCH_URL=${url}`;
  });
  if (!hasOpenSearchUrl) updated.push(`OPENSEARCH_URL=${url}`);
  return `${updated.join('\n')}\n`;
}

function containerExists(): boolean {
  return docker(['ps', '-aq', '--filter', `name=^${container}$`]).length > 0;
}

async function up(): Promise<void> {
  const image = buildSearchImage();
  if (containerExists()) {
    const existingImage = docker(['inspect', '-f', '{{.Config.Image}}', container]);
    if (existingImage !== image) docker(['rm', '-f', container]);
  }

  if (containerExists()) {
    const running = docker(['inspect', '-f', '{{.State.Running}}', container]);
    if (running !== 'true') docker(['start', container]);
  } else {
    docker(['volume', 'create', volume]);
    docker(searchRunArgs(image));
  }

  const url = `http://127.0.0.1:${port}`;
  await waitForSearch(url, container);
  const envFile = resolve(directory, '.env');
  const existingEnv = (await Bun.file(envFile).exists()) ? await Bun.file(envFile).text() : '';
  await Bun.write(envFile, developmentEnv(existingEnv, url));
}

async function rebuild(): Promise<void> {
  const { ConfigError } = await import('../src/commerce/config.ts');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new ConfigError('DATABASE_URL');
  const encodedRouteKey = process.env.KERNEL_ROUTE_KEY;
  if (!encodedRouteKey || !/^[A-Za-z0-9_-]+$/.test(encodedRouteKey)) throw new ConfigError('KERNEL_ROUTE_KEY');
  const routeKey = Buffer.from(encodedRouteKey, 'base64url');
  if (routeKey.byteLength !== 32 || routeKey.toString('base64url') !== encodedRouteKey)
    throw new ConfigError('KERNEL_ROUTE_KEY');
  const { readSearchConfig } = await import('../src/search/work.ts');
  const config = readSearchConfig(process.env);
  if (!config) throw new ConfigError('OPENSEARCH_URL');
  const { createPool } = await import('../src/database/pool.ts');
  const { createOpenSearch } = await import('../src/search/opensearch.ts');
  const { RebuildError, rebuildSubjects } = await import('../src/search/generations.ts');
  const { subjectSource } = await import('../src/semantic/search-source.ts');
  const pool = createPool(databaseUrl);
  try {
    const result = await rebuildSubjects({
      pool,
      search: createOpenSearch(config.url),
      source: subjectSource(pool, routeKey),
      prefix: config.prefix,
      // The worker's runner discovers the new generation on its own.
      runner: { async refresh() {} },
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    if (error instanceof RebuildError) {
      console.error(
        JSON.stringify({ reason: error.reason, generation: error.generation, partitions: error.partitions }),
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const action = process.argv[2] ?? 'up';
  if (action === 'up') await up();
  else if (action === 'down') {
    if (containerExists() && docker(['inspect', '-f', '{{.State.Running}}', container]) === 'true') {
      docker(['stop', container]);
    }
  } else if (action === 'reset') {
    if (containerExists()) docker(['rm', '-f', container]);
    try {
      docker(['volume', 'rm', volume]);
    } catch {
      // A missing volume is already reset.
    }
    await up();
  } else if (action === 'rebuild') await rebuild();
  else throw new Error(`Unknown search action: ${action}`);
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

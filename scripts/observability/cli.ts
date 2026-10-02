import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { greptimeRows } from './greptime.ts';

const root = resolve(import.meta.dir, '../..');
const mode = process.argv[2];
if (!['check', 'smoke'].includes(mode!))
  throw new Error('Use observability:check or observability:smoke');
const directory = resolve(root, '.temp/observability', randomUUID());
mkdirSync(directory, { recursive: true, mode: 0o700 });
const password = randomBytes(24).toString('hex');
const secretFiles = {
  GREPTIME_USERS_FILE: ['users', `telemetry=${password}\n`],
  GREPTIME_PASSWORD_FILE: ['password', password],
  PERSES_ENCRYPTION_KEY_FILE: ['encryption-key', randomBytes(16).toString('hex')],
  PERSES_GREPTIME_SECRET_FILE: [
    'perses-secret.json',
    JSON.stringify({
      kind: 'Secret',
      metadata: { name: 'greptimedb', project: 'rezics' },
      spec: { basicAuth: { username: 'telemetry', password } },
    }),
  ],
} as const;
const env: Record<string, string | undefined> = {
  ...process.env,
  GREPTIME_HTTP_PORT: '0',
  OTLP_HTTP_PORT: '0',
  PERSES_HTTP_PORT: '0',
};
for (const [key, [file, value]] of Object.entries(secretFiles)) {
  env[key] = resolve(directory, file);
  writeFileSync(env[key]!, value, { mode: 0o644 });
}
// The enclosing directory is private. Secrets must be readable by the pinned
// container users; they are mounted only into this disposable project.
const project = `rezics-otel-${randomUUID().slice(0, 8)}`;
const compose = [
  'docker',
  'compose',
  '-p',
  project,
  '-f',
  resolve(root, 'infra/observability/compose.yaml'),
];
async function run(args: string[], quiet = true) {
  const child = Bun.spawn(args, { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), 180000);
  const [code, out, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`${args.slice(0, 3).join(' ')} failed:\n${error}\n${out}`);
  if (!quiet) console.log(out);
  return out.trim();
}
async function waitFor<T>(label: string, operation: () => Promise<T | undefined>): Promise<T> {
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    try {
      const result = await operation();
      if (result !== undefined) return result;
    } catch {
      /* startup or ingestion */
    }
    await Bun.sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function endpoint(service: string, port: string) {
  return `http://${await run([...compose, 'port', service, port])}`;
}
let failed = false;
try {
  await run([...compose, 'config', '--quiet']);
  await run([
    ...compose,
    'run',
    '--rm',
    '--no-deps',
    'collector',
    'validate',
    '--config=/etc/otelcol/config.yaml',
  ]);
  console.log('Compose and Collector configuration accepted');
  if (mode === 'smoke') {
    await run([...compose, 'up', '-d']);
    const database = await endpoint('greptimedb', '4000');
    const otlp = await endpoint('collector', '4318');
    const perses = await endpoint('perses', '8080');
    const auth = {
      authorization: `Basic ${Buffer.from(`telemetry:${password}`).toString('base64')}`,
    };
    const sql = async (query: string) => {
      const response = await fetch(`${database}/v1/sql`, {
        method: 'POST',
        headers: auth,
        body: new URLSearchParams({ sql: query }),
        signal: AbortSignal.timeout(3000),
      });
      return greptimeRows(response);
    };
    await waitFor('authenticated GreptimeDB', async () => await sql('SELECT 1'));
    const unauthenticated = await fetch(`${database}/v1/sql`, {
      method: 'POST',
      body: new URLSearchParams({ sql: 'SELECT 1' }),
    });
    if (unauthenticated.status !== 401)
      throw new Error('GreptimeDB must reject unauthenticated SQL');
    await waitFor('Collector', async () =>
      (
        await fetch(`${otlp}/v1/traces`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-protobuf' },
          body: new Uint8Array(),
        })
      ).ok
        ? true
        : undefined,
    );
    const child = Bun.spawn([process.execPath, 'packages/observability/tests/runtime-child.ts'], {
      cwd: root,
      env: {
        ...env,
        OTEL_EXPORTER_OTLP_ENDPOINT: otlp,
        OTEL_EXPORTER_OTLP_HEADERS: '',
        OTEL_METRIC_EXPORT_INTERVAL: '60000',
        OTEL_TRACES_SAMPLER_ARG: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, , stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0 || stderr) throw new Error(`Telemetry producer failed: ${stderr}`);
    await waitFor('trace ingestion', async () => {
      const rows = await sql('SELECT count(*) FROM rezics_traces');
      return Number(rows?.[0]?.[0]) >= 9 ? true : undefined;
    });
    await waitFor('log ingestion', async () => {
      const rows = await sql('SELECT count(*) FROM rezics_logs');
      return Number(rows?.[0]?.[0]) >= 2 ? true : undefined;
    });
    await waitFor('cumulative HTTP metrics', async () => {
      const rows = await sql('SELECT count(*) FROM http_server_request_duration_seconds_count');
      return Number(rows?.[0]?.[0]) >= 8 ? true : undefined;
    });
    const tables = await sql('SHOW TABLES');
    writeFileSync(resolve(directory, 'tables.json'), JSON.stringify(tables, null, 2));
    const dashboards = await waitFor('Perses provisioned dashboard', async () => {
      const response = await fetch(`${perses}/api/v1/projects/rezics/dashboards/services`);
      return response.ok ? response.json() : undefined;
    });
    writeFileSync(resolve(directory, 'dashboard.json'), JSON.stringify(dashboards, null, 2));
    const create = await fetch(`${perses}/api/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'Project', metadata: { name: 'unwanted' }, spec: {} }),
    });
    if (create.ok) throw new Error('Perses must reject API edits while Git owns provisioning');
    console.log(
      'Authenticated GreptimeDB, all three signals and read-only Perses provisioning passed',
    );
  }
} catch (error) {
  failed = true;
  try {
    writeFileSync(
      resolve(directory, 'containers.log'),
      await run([...compose, 'logs', '--no-color']),
    );
  } catch {
    /* original diagnostic wins */
  }
  console.error(`Local observability diagnostics: ${directory}`);
  throw error;
} finally {
  await run([...compose, 'down', '--volumes', '--remove-orphans']).catch((error) => {
    if (!failed) throw error;
    /* preserve the original failure when Docker is unavailable */
  });
}

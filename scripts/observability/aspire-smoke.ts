import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
async function aspire(args: string[], jsonStart: '{' | '[') {
  const child = Bun.spawn(
    [
      'node',
      resolve(root, 'node_modules/@microsoft/aspire-cli/bin/aspire.js'),
      ...args,
      '--apphost',
      resolve(root, 'apphost/apphost.mts'),
      '--format',
      'Json',
      '--non-interactive',
      '--nologo',
    ],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' },
  );
  const [code, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`Aspire ${args[0]} failed; inspect task aspire logs`);
  const index = stdout.indexOf(jsonStart);
  if (index < 0) throw new Error('Aspire did not return JSON');
  return JSON.parse(stdout.slice(index));
}
const model = await aspire(['describe', '--include-hidden'], '{');
const dashboard = model.resources.find(
  (item: { displayName?: string }) => item.displayName === 'aspire-dashboard',
);
const frontend = dashboard?.urls.find((item: { name: string }) => item.name === 'https');
if (!frontend || new URL(frontend.url).protocol !== 'https:')
  throw new Error('The dashboard frontend must retain HTTPS');
for (const name of ['account', 'main']) {
  const resource = model.resources.find(
    (item: { displayName?: string; resourceType?: string }) =>
      item.displayName === name && item.resourceType === 'Executable',
  );
  if (resource?.state !== 'Running')
    throw new Error(`Start the backend AppHost before testing ${name}`);
  const origin = resource.urls.find((item: { name: string }) => item.name === 'http')?.url;
  if (!origin) throw new Error(`${name} has no HTTP endpoint`);
  const traceId = randomBytes(16).toString('hex');
  const parentId = randomBytes(8).toString('hex');
  const response = await fetch(`${origin}/health/live`, {
    headers: { traceparent: `00-${traceId}-${parentId}-01` },
    signal: AbortSignal.timeout(5000),
  });
  await response.text();
  if (response.status !== 200) throw new Error(`${name} liveness returned ${response.status}`);
  let received = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    const spans = await aspire(
      ['otel', 'spans', name, '--trace-id', traceId, '--limit', '20'],
      '[',
    );
    if (
      spans.some(
        (span: { kind?: string; name?: string; parentSpanId?: string }) =>
          span.kind === 'Server' &&
          span.name === 'GET /health/live' &&
          span.parentSpanId === parentId,
      )
    ) {
      received = true;
      break;
    }
    await Bun.sleep(1000);
  }
  if (!received)
    throw new Error(
      `${name} served HTTP but its server span did not reach Aspire; inspect OTLP transport`,
    );
  const logs = await aspire(
    ['otel', 'logs', name, '--search', `${name}_listening`, '--limit', '1'],
    '[',
  );
  if (!logs.length) throw new Error(`${name} startup log did not reach Aspire`);
  const otlp = resource.environment.OTEL_EXPORTER_OTLP_ENDPOINT;
  const rejected = await fetch(`${otlp}/v1/traces`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-protobuf' },
    body: new Uint8Array(),
    signal: AbortSignal.timeout(5000),
  });
  if (![401, 403].includes(rejected.status))
    throw new Error('Development OTLP must require the Aspire API key');
  console.log(
    `${name}: W3C server span and structured log received by Aspire; unauthenticated OTLP rejected`,
  );
}

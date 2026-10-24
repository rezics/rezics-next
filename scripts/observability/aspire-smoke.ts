import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { terminateProcessGroup } from '../qa/process/terminate.ts';

const root = resolve(import.meta.dir, '../..');
const apphostOption = process.argv.indexOf('--apphost');
const apphost = apphostOption < 0 ? resolve(root, 'apphost/apphost.mts') : resolve(process.argv[apphostOption + 1]!);
const retention = process.argv.includes('--retention');
// Include discovery, ingestion and eviction checks in one finite observation.
const deadline = Date.now() + 120_000;
function remaining(maximum: number): number {
  const milliseconds = Math.min(maximum, deadline - Date.now());
  if (milliseconds <= 0) throw new Error('Aspire observation exceeded its 120-second wall');
  return milliseconds;
}
async function aspire(args: string[], jsonStart: '{' | '[') {
  const milliseconds = remaining(30_000);
  const stdout = await aspireSmokeOutput(
    [
      'node',
      resolve(root, 'node_modules/@microsoft/aspire-cli/bin/aspire.js'),
      ...args,
      '--apphost',
      apphost,
      '--format',
      'Json',
      '--non-interactive',
      '--nologo',
    ],
    milliseconds,
  );
  const index = stdout.indexOf(jsonStart);
  if (index < 0) throw new Error('Aspire did not return JSON');
  return JSON.parse(stdout.slice(index));
}

export async function aspireSmokeOutput(command: string[], milliseconds: number): Promise<string> {
  const ends = Date.now() + milliseconds;
  // A new process group contains the npm launcher and its native CLI. Killing
  // only the launcher leaves the CLI alive with inherited stdout/stderr pipes.
  const child = spawn(command[0]!, command.slice(1), {
    cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let stopped = false;
  let stopping: Promise<void> | undefined;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; });
  child.stderr.resume(); // Drain without retaining potentially sensitive output.
  const terminate = () => {
    stopped = true;
    stopping ??= terminateProcessGroup(child.pid ?? 0, {
      graceMs: 0, killWaitMs: Math.max(0, ends - Date.now()),
    }).finally(() => {
      // Close our pipe ends too: even an unexpectedly inherited descriptor must
      // not extend discovery/retention beyond the remaining observation wall.
      child.stdout.destroy();
      child.stderr.destroy();
    });
    return stopping;
  };
  // Reserve cleanup inside the existing wall, including acknowledgement that
  // an orphaned native process can no longer execute after its pipes close.
  const wall = setTimeout(() => { void terminate(); }, milliseconds - Math.min(1000, milliseconds / 2));
  process.once('SIGINT', terminate);
  process.once('SIGTERM', terminate);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', () => reject(new Error('Aspire command could not start')));
      // close includes stream closure, even if the launcher exited earlier.
      child.once('close', resolve);
    });
    if (stopped || code !== 0) throw new Error('Aspire command failed or exceeded its observation wall; inspect task aspire logs');
    return output;
  } finally {
    clearTimeout(wall);
    process.removeListener('SIGINT', terminate);
    process.removeListener('SIGTERM', terminate);
    await terminate();
  }
}
if (import.meta.main) {
  const model = await aspire(['describe', '--include-hidden'], '{');
  const dashboard = model.resources.find(
    (item: { displayName?: string }) => item.displayName === 'aspire-dashboard',
  );
  if (dashboard?.state !== 'Running') {
    throw new Error(`Dashboard is ${dashboard?.state ?? 'absent'}; independent commands: ${Object.keys(dashboard?.commands ?? {}).join(', ') || 'none'}. Retain evidence for AppHost recovery; business resources were not restarted`);
  }
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
      signal: AbortSignal.timeout(remaining(5_000)),
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
      await Bun.sleep(remaining(1_000));
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
      signal: AbortSignal.timeout(remaining(5_000)),
    });
    if (![401, 403].includes(rejected.status))
      throw new Error('Development OTLP must require the Aspire API key');
    console.log(
      `${name}: W3C server span and structured log received by Aspire; unauthenticated OTLP rejected`,
    );
  }

  if (retention) {
    // Read the exact discovered process's credentials only into memory. Aspire
    // masks these in describe; no token is accepted on the command line or logged.
    const main = model.resources.find((item: { displayName?: string }) => item.displayName === 'main');
    const pid = main?.properties?.['executable.pid'];
    const dashboardPid = dashboard?.properties?.['executable.pid'];
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(dashboardPid))
      throw new Error('Retention observation requires discovered Main and Dashboard process IDs');
    const processEnv = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
      .filter(value => value.includes('='))
      .map(value => [value.slice(0, value.indexOf('=')), value.slice(value.indexOf('=') + 1)]));
    const headers = Object.fromEntries((processEnv.OTEL_EXPORTER_OTLP_HEADERS ?? '').split(',')
      .filter(Boolean).map(value => {
        const index = value.indexOf('=');
        return [value.slice(0, index), decodeURIComponent(value.slice(index + 1))];
      }));
    if (!Object.keys(headers).length) throw new Error('Authenticated OTLP headers unavailable');
    const endpoint = processEnv.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (!endpoint || endpoint !== main.environment.OTEL_EXPORTER_OTLP_ENDPOINT)
      throw new Error('The discovered Main process and AppHost OTLP endpoints differ');
    const dashboardEnv = Object.fromEntries(readFileSync(`/proc/${dashboardPid}/environ`, 'utf8').split('\0')
      .filter(value => value.includes('='))
      .map(value => [value.slice(0, value.indexOf('=')), value.slice(value.indexOf('=') + 1)]));
    const config = JSON.parse(readFileSync(dashboardEnv.ASPIRE_DASHBOARD_CONFIG_FILE_PATH!, 'utf8'));
    const limits = config.Dashboard.TelemetryLimits;
    // This command is an explicit finite observation of the owner policy. Refuse
    // inherited large defaults rather than turning a smoke check into a load run.
    if (limits.MaxLogCount !== 5_000 || limits.MaxTraceCount !== 2_000 ||
      dashboardEnv.DOTNET_GCHeapHardLimit !== '80000000')
      throw new Error('Start the AppHost with the committed bounded Dashboard policy before retention observation');
    const rss = () => Number(readFileSync(`/proc/${dashboardPid}/status`, 'utf8').match(/^VmRSS:\s+(\d+)/m)?.[1]) * 1024;
    const started = new Date().toISOString();
    const memory = [rss()];
    const marker = `retention-${randomBytes(8).toString('hex')}`;
    const now = BigInt(Date.now()) * 1_000_000n;
    const resource = { attributes: [{ key: 'service.name', value: { stringValue: 'main' } }] };
    const newestTrace = randomBytes(16).toString('hex');
    const oldestTrace = randomBytes(16).toString('hex');
    for (const [kind, count] of [['logs', limits.MaxLogCount + 128], ['traces', limits.MaxTraceCount + 128]] as const) {
      for (let offset = 0; offset < count; offset += 128) {
        const records = Array.from({ length: Math.min(128, count - offset) }, (_, index) => {
          const position = offset + index;
          const time = (now + BigInt(position)).toString();
          return kind === 'logs' ? { timeUnixNano: time, severityNumber: 9,
            body: { stringValue: `${marker}-${position === 0 ? 'oldest' : position === count - 1 ? 'newest' : 'sample'}` } }
            : { traceId: position === 0 ? oldestTrace : position === count - 1 ? newestTrace : randomBytes(16).toString('hex'),
              spanId: randomBytes(8).toString('hex'), name: marker, kind: 2,
              startTimeUnixNano: time, endTimeUnixNano: (now + BigInt(position) + 1n).toString() };
        });
        const response = await fetch(`${endpoint}/v1/${kind}`, {
          method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify(kind === 'logs'
            ? { resourceLogs: [{ resource, scopeLogs: [{ scope: { name: 'bounded-retention-smoke' }, logRecords: records }] }] }
            : { resourceSpans: [{ resource, scopeSpans: [{ scope: { name: 'bounded-retention-smoke' }, spans: records }] }] }),
          signal: AbortSignal.timeout(remaining(5_000)),
        });
        await response.text();
        if (response.status !== 200) throw new Error(`Authenticated retention ${kind} ingestion returned ${response.status}`);
      }
      memory.push(rss());
    }
    // Flush and eviction are asynchronous. This is one finite observation, not a
    // watcher: ten checks at most, retaining only counts and process RSS.
    let observed = false;
    let counts: Record<string, number> = {};
    for (let attempt = 0; attempt < 10; attempt++) {
      const logs = await aspire(['otel', 'logs', '--search', marker, '--limit', '5200'], '[');
      const spans = await aspire(['otel', 'spans', '--search', marker, '--limit', '2200'], '[');
      const oldLog = await aspire(['otel', 'logs', '--search', `${marker}-oldest`, '--limit', '1'], '[');
      const newLog = await aspire(['otel', 'logs', '--search', `${marker}-newest`, '--limit', '1'], '[');
      const oldSpan = await aspire(['otel', 'spans', '--trace-id', oldestTrace, '--limit', '1'], '[');
      const newSpan = await aspire(['otel', 'spans', '--trace-id', newestTrace, '--limit', '1'], '[');
      counts = { logs: logs.length, spans: spans.length };
      observed = logs.length > 0 && logs.length <= limits.MaxLogCount && spans.length > 0 &&
        spans.length <= limits.MaxTraceCount && !oldLog.length && newLog.length === 1 && !oldSpan.length && newSpan.length === 1;
      if (observed) break;
      await Bun.sleep(remaining(1_000));
    }
    memory.push(rss());
    console.log(JSON.stringify({ started, ended: new Date().toISOString(), scope: 'built-in Dashboard',
      injected: { logs: 5_128, traces: 2_128 }, retained: counts, rssBytes: memory,
      managedHeapLimitBytes: 2_147_483_648, oldestEvictedAndNewestRetained: observed }));
    if (!observed) throw new Error('Finite retention observation did not establish eviction and useful recent telemetry');
  }
}

if (retention) {
  // Read the exact discovered process's credentials only into memory. Aspire
  // masks these in describe; no token is accepted on the command line or logged.
  const main = model.resources.find((item: { displayName?: string }) => item.displayName === 'main');
  const pid = main?.properties?.['executable.pid'];
  const dashboardPid = dashboard?.properties?.['executable.pid'];
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(dashboardPid))
    throw new Error('Retention observation requires discovered Main and Dashboard process IDs');
  const processEnv = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
    .filter(value => value.includes('='))
    .map(value => [value.slice(0, value.indexOf('=')), value.slice(value.indexOf('=') + 1)]));
  const headers = Object.fromEntries((processEnv.OTEL_EXPORTER_OTLP_HEADERS ?? '').split(',')
    .filter(Boolean).map(value => {
      const index = value.indexOf('=');
      return [value.slice(0, index), decodeURIComponent(value.slice(index + 1))];
    }));
  if (!Object.keys(headers).length) throw new Error('Authenticated OTLP headers unavailable');
  const endpoint = processEnv.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || endpoint !== main.environment.OTEL_EXPORTER_OTLP_ENDPOINT)
    throw new Error('The discovered Main process and AppHost OTLP endpoints differ');
  const dashboardEnv = Object.fromEntries(readFileSync(`/proc/${dashboardPid}/environ`, 'utf8').split('\0')
    .filter(value => value.includes('='))
    .map(value => [value.slice(0, value.indexOf('=')), value.slice(value.indexOf('=') + 1)]));
  const config = JSON.parse(readFileSync(dashboardEnv.ASPIRE_DASHBOARD_CONFIG_FILE_PATH!, 'utf8'));
  const limits = config.Dashboard.TelemetryLimits;
  // This command is an explicit finite observation of the owner policy. Refuse
  // inherited large defaults rather than turning a smoke check into a load run.
  if (limits.MaxLogCount !== 5_000 || limits.MaxTraceCount !== 2_000 ||
    dashboardEnv.DOTNET_GCHeapHardLimit !== '80000000')
    throw new Error('Start the AppHost with the committed bounded Dashboard policy before retention observation');
  const rss = () => Number(readFileSync(`/proc/${dashboardPid}/status`, 'utf8').match(/^VmRSS:\s+(\d+)/m)?.[1]) * 1024;
  const started = new Date().toISOString();
  const memory = [rss()];
  const marker = `retention-${randomBytes(8).toString('hex')}`;
  const now = BigInt(Date.now()) * 1_000_000n;
  const resource = { attributes: [{ key: 'service.name', value: { stringValue: 'main' } }] };
  const newestTrace = randomBytes(16).toString('hex');
  const oldestTrace = randomBytes(16).toString('hex');
  for (const [kind, count] of [['logs', limits.MaxLogCount + 128], ['traces', limits.MaxTraceCount + 128]] as const) {
    for (let offset = 0; offset < count; offset += 128) {
      const records = Array.from({ length: Math.min(128, count - offset) }, (_, index) => {
        const position = offset + index;
        const time = (now + BigInt(position)).toString();
        return kind === 'logs' ? { timeUnixNano: time, severityNumber: 9,
          body: { stringValue: `${marker}-${position === 0 ? 'oldest' : position === count - 1 ? 'newest' : 'sample'}` } }
          : { traceId: position === 0 ? oldestTrace : position === count - 1 ? newestTrace : randomBytes(16).toString('hex'),
            spanId: randomBytes(8).toString('hex'), name: marker, kind: 2,
            startTimeUnixNano: time, endTimeUnixNano: (now + BigInt(position) + 1n).toString() };
      });
      const response = await fetch(`${endpoint}/v1/${kind}`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(kind === 'logs'
          ? { resourceLogs: [{ resource, scopeLogs: [{ scope: { name: 'bounded-retention-smoke' }, logRecords: records }] }] }
          : { resourceSpans: [{ resource, scopeSpans: [{ scope: { name: 'bounded-retention-smoke' }, spans: records }] }] }),
        signal: AbortSignal.timeout(remaining(5_000)),
      });
      await response.text();
      if (response.status !== 200) throw new Error(`Authenticated retention ${kind} ingestion returned ${response.status}`);
    }
    memory.push(rss());
  }
  // Flush and eviction are asynchronous. This is one finite observation, not a
  // watcher: ten checks at most, retaining only counts and process RSS.
  let observed = false;
  let counts: Record<string, number> = {};
  for (let attempt = 0; attempt < 10; attempt++) {
    const logs = await aspire(['otel', 'logs', '--search', marker, '--limit', '5200'], '[');
    const spans = await aspire(['otel', 'spans', '--search', marker, '--limit', '2200'], '[');
    const oldLog = await aspire(['otel', 'logs', '--search', `${marker}-oldest`, '--limit', '1'], '[');
    const newLog = await aspire(['otel', 'logs', '--search', `${marker}-newest`, '--limit', '1'], '[');
    const oldSpan = await aspire(['otel', 'spans', '--trace-id', oldestTrace, '--limit', '1'], '[');
    const newSpan = await aspire(['otel', 'spans', '--trace-id', newestTrace, '--limit', '1'], '[');
    counts = { logs: logs.length, spans: spans.length };
    observed = logs.length > 0 && logs.length <= limits.MaxLogCount && spans.length > 0 &&
      spans.length <= limits.MaxTraceCount && !oldLog.length && newLog.length === 1 && !oldSpan.length && newSpan.length === 1;
    if (observed) break;
    await Bun.sleep(remaining(1_000));
  }
  memory.push(rss());
  console.log(JSON.stringify({ started, ended: new Date().toISOString(), scope: 'built-in Dashboard',
    injected: { logs: 5_128, traces: 2_128 }, retained: counts, rssBytes: memory,
    managedHeapLimitBytes: 2_147_483_648, oldestEvictedAndNewestRetained: observed }));
  if (!observed) throw new Error('Finite retention observation did not establish eviction and useful recent telemetry');
}

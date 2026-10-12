import { context, trace } from '@opentelemetry/api';
import { registerTelemetryPeers, shutdownTelemetry, startTelemetry, TelemetryPeerConflictError, withTelemetrySpan } from '../src/runtime.ts';

const services = ['fuseki', 'account', 'main', 'other', 'baseline', 'trusted'] as const;
const servers = Object.fromEntries(services.map((service, index) => [service, {
  url: new URL(`http://127.0.0.1:${41000 + index}`), port: 41000 + index,
}]));
// Disabled telemetry must not install fetch instrumentation or retain a registration.
const originalFetch = globalThis.fetch;
registerTelemetryPeers({ FUSEKI_URL: servers.fuseki!.url.origin })();
const disabledUnchanged = originalFetch === globalThis.fetch;
// Peer responses are injected. Only the parent's OTLP receiver owns a listener.
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  if (new URL(request.url).origin === new URL(process.env.OTEL_EXPORTER_OTLP_ENDPOINT!).origin)
    return originalFetch(input, init);
  return Response.json({ traceparent: request.headers.get('traceparent') },
    { headers: { 'server-timing': 'jena;dur=7.5' } });
}, originalFetch);
startTelemetry('telemetry-peers', {
  ...process.env,
  FUSEKI_URL: `${servers.baseline!.url.origin}/rezics/`,
  ACCOUNT_ORIGIN: undefined, ACCOUNT_JWKS_URL: undefined, ACCOUNT_INTROSPECT_URL: undefined,
  MAIN_ORIGIN: undefined,
  OTEL_PROPAGATION_ORIGINS: servers.trusted!.url.origin,
});
const env = {
  FUSEKI_URL: `${servers.fuseki!.url.origin}/rezics/`,
  ACCOUNT_ORIGIN: servers.account!.url.origin,
  ACCOUNT_JWKS_URL: `${servers.account!.url.origin}/jwks`,
  ACCOUNT_INTROSPECT_URL: `${servers.account!.url.origin}/introspect`,
  MAIN_ORIGIN: servers.main!.url.origin,
};
const samples: { phase: string; service: string; port: number; traceId: string; traceparent: string | null }[] = [];
async function sample(phase: string, selected: readonly typeof services[number][] = services) {
  await withTelemetrySpan(phase, async () => {
    const traceId = trace.getSpan(context.active())!.spanContext().traceId;
    for (const service of selected) {
      const server = servers[service]!;
      const response = await fetch(`${server.url.origin}/probe`, { method: 'POST', body: 'SELECT 1' });
      const body = await response.json() as { traceparent: string | null };
      samples.push({ phase, service, port: server.port!, traceId, ...body });
    }
  });
}
let conflictRejected = false, invalidRejected = false;
const conflicts: { origin: string; existingService: string; incomingService: string; message: string }[] = [];
function conflict(error: unknown) {
  if (!(error instanceof TelemetryPeerConflictError)) throw error;
  const { origin, existingService, incomingService, message } = error;
  conflicts.push({ origin, existingService, incomingService, message });
}
try {
  await sample('before');
  const undoFirst = registerTelemetryPeers(env);
  const undoSecond = registerTelemetryPeers(env);
  await sample('registered');
  undoFirst(); undoFirst();
  await sample('overlap');
  try {
    registerTelemetryPeers({ FUSEKI_URL: servers.other!.url.origin, MAIN_ORIGIN: servers.fuseki!.url.origin });
  } catch (error) { conflict(error); conflictRejected = true; }
  try {
    registerTelemetryPeers({ FUSEKI_URL: servers.other!.url.origin, ACCOUNT_ORIGIN: 'invalid-url' });
  } catch { invalidRejected = true; }
  await sample('rejected', ['other', 'fuseki']);
  undoSecond(); undoSecond();
  await sample('removed');
  for (const key of ['ACCOUNT_ORIGIN', 'MAIN_ORIGIN']) {
    try {
      registerTelemetryPeers({ FUSEKI_URL: `${servers.other!.url.origin}/dataset/`,
        [key]: `${servers.other!.url.origin}/auth/` });
      throw new Error('Conflicting incoming services were accepted');
    } catch (error) { conflict(error); }
    await sample(`incoming-${key}`, ['other']);
  }
  for (const key of ['ACCOUNT_ORIGIN', 'ACCOUNT_JWKS_URL', 'ACCOUNT_INTROSPECT_URL']) {
    const undo = registerTelemetryPeers({ [key]: `${servers.account!.url.origin}/auth` });
    await sample(key, ['account']);
    undo();
  }
  const undoBaseline = registerTelemetryPeers({ FUSEKI_URL: servers.baseline!.url.origin });
  const undoTrusted = registerTelemetryPeers({ MAIN_ORIGIN: servers.trusted!.url.origin });
  undoBaseline(); undoTrusted();
  await sample('preserved', ['baseline', 'trusted']);
  console.log(JSON.stringify({ samples, disabledUnchanged, conflictRejected, invalidRejected, conflicts }));
} finally {
  await shutdownTelemetry();
  globalThis.fetch = originalFetch;
}

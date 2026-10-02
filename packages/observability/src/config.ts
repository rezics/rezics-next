import { cleanEnv, num, str, url } from 'envalid';

/** Standard OTLP/HTTP settings; Aspire supplies the endpoint and auth header. */
export const telemetrySpec = {
  OTEL_SDK_DISABLED: str({
    choices: ['true', 'false'],
    default: 'false',
    desc: 'Disable telemetry explicitly; without an OTLP endpoint telemetry is also disabled.',
  }),
  OTEL_EXPORTER_OTLP_ENDPOINT: url({
    default: undefined,
    desc: 'OTLP/HTTP base URL (no /v1/traces suffix). Aspire supplies this in development.',
    example: 'http://127.0.0.1:4318',
  }),
  OTEL_EXPORTER_OTLP_PROTOCOL: str({
    choices: ['http/protobuf'],
    default: 'http/protobuf',
    desc: 'All three signals use OTLP HTTP protobuf.',
  }),
  OTEL_EXPORTER_OTLP_HEADERS: str({
    default: '',
    desc: 'Comma-separated percent-encoded OTLP auth headers; supplied as a secret.',
  }),
  OTEL_EXPORTER_OTLP_TIMEOUT: num({
    default: 5000,
    desc: 'Exporter timeout in milliseconds; telemetry does not block request completion.',
  }),
  OTEL_SERVICE_VERSION: str({
    default: 'development',
    desc: 'Release artifact ID or deployed revision.',
  }),
  OTEL_SERVICE_NAME: str({
    default: undefined,
    desc: 'Service resource name; Aspire supplies its resource name, otherwise the entrypoint provides it.',
  }),
  OTEL_RESOURCE_ATTRIBUTES: str({
    default: '',
    desc: 'Standard resource attributes; only service.instance.id is accepted, to associate Aspire resources.',
  }),
  OTEL_DEPLOYMENT_ENVIRONMENT: str({
    default: 'development',
    desc: 'Deployment environment name; production in release images.',
  }),
  OTEL_TRACES_SAMPLER_ARG: num({
    default: 1,
    desc: 'Parent-based root trace sampling ratio, from 0 to 1. Metrics and logs are independent.',
  }),
  OTEL_METRIC_EXPORT_INTERVAL: num({
    default: 15000,
    desc: 'Cumulative explicit-bucket metric export interval in milliseconds.',
  }),
  OTEL_PROPAGATION_ORIGINS: str({
    default: '',
    desc: 'Comma-separated trusted HTTP origins receiving outbound W3C trace headers; no baggage is forwarded.',
  }),
};

export function telemetryConfig(env: Record<string, string | undefined> = process.env) {
  const config = cleanEnv(env, telemetrySpec, {
    reporter: ({ errors }) => {
      if (Object.keys(errors).length)
        throw new Error(`Invalid telemetry settings: ${Object.keys(errors).join(', ')}`);
    },
  });
  if (
    !Number.isFinite(config.OTEL_TRACES_SAMPLER_ARG) ||
    config.OTEL_TRACES_SAMPLER_ARG < 0 ||
    config.OTEL_TRACES_SAMPLER_ARG > 1
  )
    throw new Error('OTEL_TRACES_SAMPLER_ARG must be from 0 to 1');
  for (const name of ['OTEL_EXPORTER_OTLP_TIMEOUT', 'OTEL_METRIC_EXPORT_INTERVAL'] as const) {
    if (!Number.isInteger(config[name]) || config[name] < 100 || config[name] > 60000)
      throw new Error(`Invalid ${name}`);
  }
  const headers: Record<string, string> = {};
  for (const entry of config.OTEL_EXPORTER_OTLP_HEADERS.split(',').filter(Boolean)) {
    const equal = entry.indexOf('=');
    if (equal <= 0) throw new Error('Invalid OTEL_EXPORTER_OTLP_HEADERS');
    try {
      headers[decodeURIComponent(entry.slice(0, equal).trim())] = decodeURIComponent(
        entry.slice(equal + 1).trim(),
      );
    } catch {
      throw new Error('Invalid OTEL_EXPORTER_OTLP_HEADERS encoding');
    }
  }
  const propagationOrigins = new Set(
    config.OTEL_PROPAGATION_ORIGINS.split(',')
      .filter(Boolean)
      .map((value) => new URL(value.trim()).origin),
  );
  if (config.OTEL_EXPORTER_OTLP_ENDPOINT) {
    const endpoint = new URL(config.OTEL_EXPORTER_OTLP_ENDPOINT);
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error(
        'OTEL_EXPORTER_OTLP_ENDPOINT requires a plain HTTP(S) base URL; put credentials in OTEL_EXPORTER_OTLP_HEADERS',
      );
  }
  return {
    ...config,
    headers,
    propagationOrigins,
    enabled: config.OTEL_SDK_DISABLED !== 'true' && !!config.OTEL_EXPORTER_OTLP_ENDPOINT,
  };
}

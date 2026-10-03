import type { WorkProfileSource, WorkSpan } from './work-profile.ts';

interface Attribute {
  key: string;
  value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean };
}
interface DashboardTrace {
  data: {
    resourceSpans?: {
      resource?: { attributes?: Attribute[] };
      scopeSpans?: {
        spans?: {
          traceId: string;
          spanId: string;
          parentSpanId?: string;
          name: string;
          kind: number;
          startTimeUnixNano: string;
          endTimeUnixNano: string;
          attributes?: Attribute[];
        }[];
      }[];
    }[];
  };
  totalCount: number;
  returnedCount: number;
}
function values(input: Attribute[] = []): Record<string, unknown> {
  return Object.fromEntries(
    input.map(({ key, value }) => [
      key,
      value.stringValue ??
        (value.intValue !== undefined
          ? Number(value.intValue)
          : (value.doubleValue ?? value.boolValue)),
    ]),
  );
}

/** Aspire's trace endpoint returns every owner, unlike a Main-only spans listing.
 * Authentication/TLS failures and truncated responses fail measurement explicitly. */
export function aspireWorkProfileSource(options: {
  dashboardOrigin: string;
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  settleMs?: number;
}): WorkProfileSource {
  const origin = new URL(options.dashboardOrigin);
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    throw new Error('Provide the dashboard origin, not its login URL');
  const timeoutMs = options.timeoutMs ?? 10_000,
    settleMs = options.settleMs ?? 1_250;
  if (
    !Number.isFinite(settleMs) ||
    settleMs < 0 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= settleMs
  )
    throw new Error('Invalid dashboard collection bounds');
  return {
    async collect(traceId, parentSpanId) {
      if (!/^[0-9a-f]{32}$/.test(traceId)) throw new Error('Invalid trace ID');
      const deadline = performance.now() + timeoutMs;
      let last = '',
        changed = performance.now();
      while (performance.now() < deadline) {
        const response = await (options.fetch ?? fetch)(
          new URL(`/api/telemetry/traces/${traceId}`, origin),
          {
            headers: options.apiKey ? { 'x-api-key': options.apiKey } : {},
            signal: AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now()))),
          },
        );
        if (response.status === 404) {
          await Bun.sleep(100);
          continue;
        }
        if (!response.ok) throw new Error(`Aspire telemetry returned HTTP ${response.status}`);
        const data = (await response.json()) as DashboardTrace;
        if (!Number.isSafeInteger(data.totalCount) || data.totalCount !== data.returnedCount)
          throw new Error('Aspire trace is truncated or missing its counts');
        const spans: WorkSpan[] = (data.data?.resourceSpans ?? []).flatMap((resource) => {
          const attrs = values(resource.resource?.attributes ?? []);
          return (resource.scopeSpans ?? []).flatMap((scope) =>
            (scope.spans ?? []).map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              parentSpanId: span.parentSpanId ?? '',
              service: String(attrs['service.name'] ?? 'unknown'),
              name: span.name,
              kind: span.kind - 1,
              startMs: Number(span.startTimeUnixNano) / 1e6,
              endMs: Number(span.endTimeUnixNano) / 1e6,
              attributes: values(span.attributes ?? []),
            })),
          );
        });
        if (
          spans.length !== data.returnedCount ||
          spans.some(
            (span) =>
              span.traceId !== traceId ||
              !/^[0-9a-f]{16}$/.test(span.spanId) ||
              !Number.isFinite(span.startMs) ||
              !Number.isFinite(span.endMs) ||
              span.endMs < span.startMs,
          )
        )
          throw new Error('Aspire returned an invalid trace');
        const signature = spans
          .map((span) => span.spanId)
          .sort()
          .join(',');
        if (signature !== last) {
          last = signature;
          changed = performance.now();
        }
        if (
          spans.some((span) => span.kind === 1 && span.parentSpanId === parentSpanId) &&
          performance.now() - changed >= settleMs
        )
          return spans;
        await Bun.sleep(100);
      }
      throw new Error('Aspire request trace did not settle');
    },
  };
}

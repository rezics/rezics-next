import protobuf from 'protobufjs';

// Minimal decoder for the public OTLP wire fields exercised here. Field numbers
// follow https://github.com/open-telemetry/opentelemetry-proto (Apache-2.0).
const schema = `syntax = "proto3";
message Value { string stringValue=1; bool boolValue=2; int64 intValue=3; double doubleValue=4; }
message Attribute { string key=1; Value value=2; }
message Resource { repeated Attribute attributes=1; }
message Scope { string name=1; }
message Status { string message=2; int32 code=3; }
message Span { bytes traceId=1; bytes spanId=2; bytes parentSpanId=4; string name=5; int32 kind=6; repeated Attribute attributes=9; Status status=15; }
message ScopeSpans { Scope scope=1; repeated Span spans=2; }
message ResourceSpans { Resource resource=1; repeated ScopeSpans scopeSpans=2; }
message Traces { repeated ResourceSpans resourceSpans=1; }
message Point { fixed64 count=4; double sum=5; repeated fixed64 bucketCounts=6; repeated double explicitBounds=7; repeated Attribute attributes=9; }
message Histogram { repeated Point dataPoints=1; int32 aggregationTemporality=2; }
message Metric { string name=1; string unit=3; Histogram histogram=9; bytes exponentialHistogram=10; }
message ScopeMetrics { repeated Metric metrics=2; }
message ResourceMetrics { Resource resource=1; repeated ScopeMetrics scopeMetrics=2; }
message Metrics { repeated ResourceMetrics resourceMetrics=1; }
message LogRecord { fixed64 timeUnixNano=1; int32 severityNumber=2; string severityText=3; Value body=5; repeated Attribute attributes=6; bytes traceId=9; bytes spanId=10; }
message ScopeLogs { repeated LogRecord logRecords=2; }
message ResourceLogs { Resource resource=1; repeated ScopeLogs scopeLogs=2; }
message Logs { repeated ResourceLogs resourceLogs=1; }`;
const root = protobuf.parse(schema).root;
export function decode(
  signal: 'Traces' | 'Metrics' | 'Logs',
  bytes: Uint8Array,
): Record<string, any> {
  const type = root.lookupType(signal);
  return type.toObject(type.decode(bytes), { longs: Number, bytes: String }) as Record<string, any>;
}
export function attributes(values: { key: string; value: Record<string, unknown> }[]) {
  return Object.fromEntries(values.map(({ key, value }) => [key, Object.values(value)[0]]));
}

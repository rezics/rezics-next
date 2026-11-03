import { createHash } from 'node:crypto';
import { checkMediaImportStatus } from '@rezics/definitions/media-import';
import { checkBatch, checkRequest, checkResult } from './accepted-checks.ts';
import { InspectionFailure } from './inspection-open.ts';
import { isImportSourceRecordMetadataResult } from './source-record-runtime.ts';

export const DEFAULT_BINDING_PAGE_SIZE = 20;
export const MAX_BINDING_PAGE_SIZE = 100;
export const BINDING_BODY_BUDGET = 65_536;
export const BINDING_JSON_NODES = 65_536;
export const BINDING_JSON_DEPTH = 32;
export const BINDING_CURSOR_BYTES = 2048;
export const BINDING_SOURCE_BYTES = 32;
export const BINDING_RECORD_BYTES = 255;
export const BINDING_KEY_BYTES = 255;
export const BINDING_SIGNATURE_BYTES = 128;
export const BINDING_SCHEMA_TOKEN = 'binding-1';

export const BINDING_SOURCE_ID = /^[a-z][a-z0-9_-]{0,31}$/u;
export const BINDING_REQUEST_KEY = /^[\x20-\x7e]+$/u;
export const BINDING_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIELD_GROUPS = ['facts', 'summary', 'cover'] as const;
const OPERATIONS = ['create', 'propose', 'retract'] as const;
const METADATA_EFFECTS = ['filled', 'corrected', 'noEffect'] as const;
const MEDIA_STATES = ['reserved', 'rejected', 'uploaded', 'available'] as const;

export type BindingInspectionPageKind = 'semantic' | 'candidates' | 'media' | 'metadata';
export type BindingInspectionState = 'pending' | 'bound' | 'taken-down' | 'absent';
export type BindingSectionAvailability = 'available' | 'not-retained' | 'unavailable';
export type BindingFieldGroup = (typeof FIELD_GROUPS)[number];
export type BindingOperation = (typeof OPERATIONS)[number];
export type BindingMetadataEffect = (typeof METADATA_EFFECTS)[number];
export type BindingMediaState = (typeof MEDIA_STATES)[number];

export type BindingInspectionRequest = Readonly<{
  source: string;
  record: string;
  page?: BindingInspectionPageKind;
  limit?: number;
  cursor?: string;
  request?: string;
}>;

export type BindingInspectionMetrics = Readonly<{
  queries: number;
  visitedRows: number;
  bodyBytesCopied: number;
  bodyBytesDecoded: number;
  bodyBytesHashed: number;
  maxBufferBytes: number;
}>;

export type BindingNativeIdentifiers = Readonly<{
  subject?: string;
  candidate?: string;
  revision?: number;
  media?: string;
  metadataRevision?: number;
}>;

export type BindingBodyProjection = Readonly<{
  byteLength: number | null;
  sha256: string | null;
  digestOmitted: string | null;
}>;

export type BindingInspectionRow = Readonly<{
  display: 'retained' | 'unavailable';
  category: BindingInspectionPageKind;
  key: string;
  ordering: Readonly<{ fieldGroup?: BindingFieldGroup; candidate?: string }>;
  reason: string | null;
  signature: string | null;
  body: BindingBodyProjection;
  operation: BindingOperation | null;
  fieldGroup: BindingFieldGroup | null;
  acknowledgement: 'absent' | 'present' | 'unknown';
  native: BindingNativeIdentifiers | null;
  candidate: string | null;
  subject: string | null;
  originalKey: string | null;
  mediaAccepted: 'absent' | 'reserved' | 'unavailable';
  mediaStatus: BindingMediaState | 'absent' | 'unavailable';
  coverPermission: 'none' | 'available-cover';
  metadataEffect: BindingMetadataEffect | null;
  storedCapacityNote: string | null;
}>;

export type BindingInspectionPage = Readonly<{
  kind: BindingInspectionPageKind;
  limit: number;
  end: 'end' | 'more';
  nextCursor?: string;
  snapshot: 'local';
  rows: readonly BindingInspectionRow[];
}>;

export type BindingInspectionDetail = Readonly<{
  category: BindingInspectionPageKind;
  row: BindingInspectionRow;
  explained: string;
}>;

export type BindingInspectionDocument = Readonly<{
  version: 1;
  source: string;
  record: string;
  capture: 'local';
  runRow: 'present' | 'absent' | 'unavailable';
  binding: Readonly<{
    state: BindingInspectionState;
    subject: string | null;
    bootstrapKey: string | null;
    currentMetadataKey: string | null;
    currentCoverKey: string | null;
    storedCandidateCapacity: number | null;
    storedGroupCapacity: readonly Readonly<{ fieldGroup: BindingFieldGroup; storedCapacity: number }>[] | null;
  }>;
  sections: Readonly<{
    semantic: BindingSectionAvailability;
    candidates: BindingSectionAvailability;
    media: BindingSectionAvailability;
    metadata: BindingSectionAvailability;
  }>;
  page: BindingInspectionPage | null;
  request: BindingInspectionDetail | null;
  resume: string;
}>;

export type MutableBindingMetrics = {
  queries: number;
  visitedRows: number;
  bodyBytesCopied: number;
  bodyBytesDecoded: number;
  bodyBytesHashed: number;
  maxBufferBytes: number;
};

export function emptyBindingMetrics(): MutableBindingMetrics {
  return {
    queries: 0,
    visitedRows: 0,
    bodyBytesCopied: 0,
    bodyBytesDecoded: 0,
    bodyBytesHashed: 0,
    maxBufferBytes: 0,
  };
}

export function freezeBindingMetrics(value: MutableBindingMetrics): BindingInspectionMetrics {
  return { ...value };
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function isBindingPageKind(value: string): value is BindingInspectionPageKind {
  return value === 'semantic' || value === 'candidates' || value === 'media' || value === 'metadata';
}

export function isFieldGroup(value: unknown): value is BindingFieldGroup {
  return value === 'facts' || value === 'summary' || value === 'cover';
}

export function validBindingSource(value: unknown): asserts value is string {
  if (typeof value !== 'string' || utf8Bytes(value) > BINDING_SOURCE_BYTES || !BINDING_SOURCE_ID.test(value))
    throw new InspectionFailure('Source must be an exact configured source identifier.', 2);
}

export function validBindingRecord(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    utf8Bytes(value) > BINDING_RECORD_BYTES ||
    value.includes('\0')
  )
    throw new InspectionFailure('Record key must be an exact stored external record identifier.', 2);
}

export function validBindingRequestKey(source: string, record: string, value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    utf8Bytes(value) > BINDING_KEY_BYTES ||
    !BINDING_REQUEST_KEY.test(value) ||
    !value.startsWith(`${source}:${record}:`) ||
    value.length <= source.length + record.length + 2
  )
    throw new InspectionFailure('Request key must be the exact original stored request identifier.', 2);
}

export function parseCandidateLocator(value: string): { fieldGroup: BindingFieldGroup; candidate: string } {
  if (utf8Bytes(value) > BINDING_KEY_BYTES + 16)
    throw new InspectionFailure('Candidate locator must be field-group/candidate-uuid.', 2);
  const slash = value.indexOf('/');
  const fieldGroup = value.slice(0, slash);
  const candidate = value.slice(slash + 1);
  if (slash <= 0 || !isFieldGroup(fieldGroup) || !BINDING_UUID.test(candidate))
    throw new InspectionFailure('Candidate locator must be field-group/candidate-uuid.', 2);
  return { fieldGroup, candidate };
}

export function candidateLocator(fieldGroup: BindingFieldGroup, candidate: string): string {
  return `${fieldGroup}/${candidate}`;
}

function exactObject(value: unknown, required: readonly string[], label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key))
  )
    throw new InspectionFailure(`Malformed binding cursor: ${label} has an unsupported shape.`, 2);
  return value as Record<string, unknown>;
}

export function encodeBindingCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeBindingCursor(
  value: string,
  request: BindingInspectionRequest,
  schema: string,
): Record<string, unknown> {
  if (utf8Bytes(value) > BINDING_CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/u.test(value))
    throw new InspectionFailure('Cursor is malformed or exceeds its bound.', 2);
  let decoded: string;
  let cursor: unknown;
  try {
    decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== value) throw new Error('noncanonical');
    cursor = JSON.parse(decoded) as unknown;
  } catch {
    throw new InspectionFailure('Cursor is malformed or noncanonical.', 2);
  }
  const keys =
    request.page === 'candidates'
      ? ['v', 'source', 'record', 'category', 'schema', 'fieldGroup', 'candidate']
      : ['v', 'source', 'record', 'category', 'schema', 'key'];
  const result = exactObject(cursor, keys, 'cursor');
  if (
    result.v !== 1 ||
    result.source !== request.source ||
    result.record !== request.record ||
    result.category !== request.page ||
    result.schema !== schema
  )
    throw new InspectionFailure('Cursor belongs to a different source, record, category or schema.', 2);
  if (request.page === 'candidates') {
    if (
      !isFieldGroup(result.fieldGroup) ||
      typeof result.candidate !== 'string' ||
      !BINDING_UUID.test(result.candidate)
    )
      throw new InspectionFailure('Cursor candidate ordering key is invalid.', 2);
  } else if (
    typeof result.key !== 'string' ||
    utf8Bytes(result.key) > BINDING_KEY_BYTES ||
    !BINDING_REQUEST_KEY.test(result.key)
  )
    throw new InspectionFailure('Cursor request ordering key is invalid.', 2);
  return result;
}

export function nextBindingCursor(
  request: BindingInspectionRequest,
  schema: string,
  last: BindingInspectionRow,
): string {
  if (request.page === 'candidates') {
    if (!last.ordering.fieldGroup || !last.ordering.candidate)
      throw new InspectionFailure('Malformed journal row: candidate ordering metadata is unsupported.');
    return encodeBindingCursor({
      v: 1,
      source: request.source,
      record: request.record,
      category: request.page,
      schema,
      fieldGroup: last.ordering.fieldGroup,
      candidate: last.ordering.candidate,
    });
  }
  return encodeBindingCursor({
    v: 1,
    source: request.source,
    record: request.record,
    category: request.page,
    schema,
    key: last.key,
  });
}

export function safeSignature(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || utf8Bytes(value) > BINDING_SIGNATURE_BYTES) return null;
  if (!/^[\x20-\x7e]+$/u.test(value)) return null;
  return value;
}

export function sha256Utf8(value: string, metrics: MutableBindingMetrics): string {
  const bytes = utf8Bytes(value);
  metrics.bodyBytesHashed += bytes;
  if (bytes > metrics.maxBufferBytes) metrics.maxBufferBytes = bytes;
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function projectBody(
  loaded: string | null,
  byteLength: number | null,
  metrics: MutableBindingMetrics,
): BindingBodyProjection {
  if (byteLength === null)
    return { byteLength: null, sha256: null, digestOmitted: 'stored body length is not a bounded integer' };
  if (byteLength > BINDING_BODY_BUDGET)
    return {
      byteLength,
      sha256: null,
      digestOmitted: `stored body exceeds the ${BINDING_BODY_BUDGET}-byte inspection budget`,
    };
  if (loaded === null)
    return {
      byteLength,
      sha256: null,
      digestOmitted: 'stored body was not loaded under the inspection byte budget',
    };
  metrics.bodyBytesCopied += utf8Bytes(loaded);
  if (utf8Bytes(loaded) !== byteLength)
    return {
      byteLength,
      sha256: null,
      digestOmitted: 'stored body length disagrees with the loaded value',
    };
  return { byteLength, sha256: sha256Utf8(loaded, metrics), digestOmitted: null };
}

function chargeJson(text: string, metrics: MutableBindingMetrics): void {
  const bytes = utf8Bytes(text);
  metrics.bodyBytesDecoded += bytes;
  if (bytes > metrics.maxBufferBytes) metrics.maxBufferBytes = bytes;
}

export function boundedJson(text: string, metrics: MutableBindingMetrics): unknown {
  if (utf8Bytes(text) > BINDING_BODY_BUDGET) throw new InspectionFailure('Stored JSON exceeds the inspection budget.');
  chargeJson(text, metrics);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new InspectionFailure('Stored JSON is not valid.');
  }
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > BINDING_JSON_DEPTH || ++nodes > BINDING_JSON_NODES)
      throw new InspectionFailure('Stored JSON exceeds node or depth budget.');
    if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string')
      return value;
    if (typeof value !== 'object') throw new InspectionFailure('Stored JSON contains an unsupported value.');
    if (ancestors.has(value)) throw new InspectionFailure('Stored JSON contains a cycle.');
    ancestors.add(value);
    if (Array.isArray(value)) {
      if (value.length > BINDING_JSON_NODES) throw new InspectionFailure('Stored JSON exceeds node budget.');
      for (const item of value) visit(item, depth + 1);
    } else {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null)
        throw new InspectionFailure('Stored JSON has an unsupported prototype.');
      const keys = Object.keys(value);
      if (keys.length > BINDING_JSON_NODES) throw new InspectionFailure('Stored JSON exceeds node budget.');
      for (const key of keys) visit((value as Record<string, unknown>)[key], depth + 1);
    }
    ancestors.delete(value);
    return value;
  };
  return visit(parsed, 0);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function commandProjection(command: Record<string, unknown>): {
  operation: BindingOperation | null;
  fieldGroup: BindingFieldGroup | null;
  subject: string | null;
  candidate: string | null;
} {
  const operation = OPERATIONS.includes(command.op as BindingOperation) ? (command.op as BindingOperation) : null;
  const source = asRecord(command.source);
  const fieldGroup = source && isFieldGroup(source.field_group) ? source.field_group : null;
  const subject = typeof command.subject === 'string' && BINDING_UUID.test(command.subject) ? command.subject : null;
  const candidate =
    typeof command.candidate === 'string' && BINDING_UUID.test(command.candidate) ? command.candidate : null;
  return { operation, fieldGroup, subject, candidate };
}

function resultProjection(result: unknown): BindingNativeIdentifiers | null {
  const envelope = asRecord(result);
  const rows = envelope && Array.isArray(envelope.results) ? envelope.results : null;
  if (!rows || rows.length !== 1) return null;
  const row = asRecord(rows[0]);
  if (!row) return null;
  const status = row.status;
  if (status !== 200 && status !== 201) return null;
  const value = asRecord(row.value);
  if (!value) return null;
  const native: { subject?: string; candidate?: string; revision?: number } = {};
  if (typeof value.id === 'string' && BINDING_UUID.test(value.id)) native.subject = value.id;
  if (typeof value.candidate === 'string' && BINDING_UUID.test(value.candidate)) native.candidate = value.candidate;
  if (typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision > 0)
    native.revision = value.revision;
  return Object.keys(native).length ? native : null;
}

export function decodeSemanticBody(
  text: string | null,
  metrics: MutableBindingMetrics,
): {
  operation: BindingOperation | null;
  fieldGroup: BindingFieldGroup | null;
  subject: string | null;
  candidate: string | null;
  usable: boolean;
} {
  if (text === null) return { operation: null, fieldGroup: null, subject: null, candidate: null, usable: false };
  try {
    const parsed = boundedJson(text, metrics);
    if (checkBatch(parsed).length !== 0)
      return { operation: null, fieldGroup: null, subject: null, candidate: null, usable: false };
    const commands = asRecord(parsed)?.commands;
    if (!Array.isArray(commands) || commands.length !== 1)
      return { operation: null, fieldGroup: null, subject: null, candidate: null, usable: false };
    const command = asRecord(commands[0]);
    if (!command) return { operation: null, fieldGroup: null, subject: null, candidate: null, usable: false };
    return { ...commandProjection(command), usable: true };
  } catch {
    return { operation: null, fieldGroup: null, subject: null, candidate: null, usable: false };
  }
}

export function decodeSemanticAck(
  text: string | null,
  metrics: MutableBindingMetrics,
): BindingNativeIdentifiers | null {
  if (text === null) return null;
  try {
    const parsed = boundedJson(text, metrics);
    if (checkResult(parsed).length !== 0) return null;
    return resultProjection(parsed);
  } catch {
    return null;
  }
}

export function decodeMediaBody(
  text: string | null,
  metrics: MutableBindingMetrics,
): { subject: string | null; usable: boolean } {
  if (text === null) return { subject: null, usable: false };
  try {
    const parsed = boundedJson(text, metrics);
    if (checkRequest(parsed).length !== 0) return { subject: null, usable: false };
    const container = asRecord(parsed)?.containerId;
    return {
      subject: typeof container === 'string' && BINDING_UUID.test(container) ? container : null,
      usable: true,
    };
  } catch {
    return { subject: null, usable: false };
  }
}

export function decodeMediaAccepted(
  text: string | null,
  metrics: MutableBindingMetrics,
): { media: string | null; usable: boolean } {
  if (text === null) return { media: null, usable: false };
  try {
    const parsed = boundedJson(text, metrics);
    const media = asRecord(asRecord(parsed)?.media);
    if (!media || media.state !== 'reserved' || media.purpose !== 'cover') return { media: null, usable: false };
    const id = typeof media.id === 'string' && BINDING_UUID.test(media.id) ? media.id : null;
    return { media: id, usable: true };
  } catch {
    return { media: null, usable: false };
  }
}

export function decodeMediaStatus(
  text: string | null,
  metrics: MutableBindingMetrics,
): { state: BindingMediaState | null; media: string | null; usable: boolean } {
  if (text === null) return { state: null, media: null, usable: false };
  try {
    const parsed = boundedJson(text, metrics);
    if (checkMediaImportStatus(parsed).length !== 0) return { state: null, media: null, usable: false };
    const media = asRecord(asRecord(parsed)?.media);
    const state = MEDIA_STATES.includes(media?.state as BindingMediaState) ? (media!.state as BindingMediaState) : null;
    const id = typeof media?.id === 'string' && BINDING_UUID.test(media.id) ? media.id : null;
    return { state, media: id, usable: state !== null };
  } catch {
    return { state: null, media: null, usable: false };
  }
}

export function decodeMetadataAck(
  text: string | null,
  metrics: MutableBindingMetrics,
): { effect: BindingMetadataEffect | null; metadataRevision: number | null; usable: boolean } {
  if (text === null) return { effect: null, metadataRevision: null, usable: false };
  try {
    const parsed = boundedJson(text, metrics);
    if (!isImportSourceRecordMetadataResult(parsed)) return { effect: null, metadataRevision: null, usable: false };
    return {
      effect: parsed.effect as BindingMetadataEffect,
      metadataRevision: parsed.metadata_revision,
      usable: true,
    };
  } catch {
    return { effect: null, metadataRevision: null, usable: false };
  }
}

export function decodeMetadataBody(text: string | null, metrics: MutableBindingMetrics): { usable: boolean } {
  if (text === null) return { usable: false };
  try {
    const parsed = boundedJson(text, metrics);
    const command = asRecord(parsed);
    if (!command) return { usable: false };
    const keys = Object.keys(command).sort().join(',');
    if (keys !== 'expected_metadata_revision,external_id,metadata,source') return { usable: false };
    return { usable: true };
  } catch {
    return { usable: false };
  }
}

export function unavailableRow(
  category: BindingInspectionPageKind,
  key: string,
  reason: string,
  body: BindingBodyProjection,
  ordering: BindingInspectionRow['ordering'] = {},
): BindingInspectionRow {
  return {
    display: 'unavailable',
    category,
    key,
    ordering,
    reason,
    signature: null,
    body,
    operation: null,
    fieldGroup: ordering.fieldGroup ?? null,
    acknowledgement: 'unknown',
    native: null,
    candidate: ordering.candidate ?? null,
    subject: null,
    originalKey: null,
    mediaAccepted: 'unavailable',
    mediaStatus: 'unavailable',
    coverPermission: 'none',
    metadataEffect: null,
    storedCapacityNote: null,
  };
}

export function bindingResumeGuidance(source: string): string {
  return [
    'Inspection is a local capture and does not authorize a native request, mint a new key or change retained bytes.',
    'Resolve an original uncertain request with the existing authorized importer; it rechecks current registration, credentials, fences and original immutable bytes/key:',
    `  bun services/importer/src/cli.ts --source <original-source-kind> --source-alias ${JSON.stringify(source)} --dump <complete-input-path> --state <same-state-path> --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin>`,
    'Sealed resume remains the ordinary import command. Source-observation CAS is a separate command and is not a binding acknowledgement.',
  ].join(' ');
}

export function bindingStateExplanation(state: BindingInspectionState): string {
  if (state === 'pending')
    return 'A bootstrap original request is retained without a local acknowledgement. An absent acknowledgement is not proof that the server did nothing.';
  if (state === 'bound')
    return 'A subject binding is locally acknowledged. That receipt is not current native visibility, public selection or a live fence.';
  if (state === 'taken-down')
    return 'This local binding records an observed native 404. It is not a fresh fence or a live visibility check.';
  return 'No binding_records row exists for this exact source and record. That is not evidence that the source itself is absent.';
}

export function integerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function requiredInteger(value: unknown, label: string): number {
  const parsed = integerOrNull(value);
  if (parsed === null) throw new InspectionFailure(`Malformed journal value: ${label} is not a bounded integer.`);
  return parsed;
}

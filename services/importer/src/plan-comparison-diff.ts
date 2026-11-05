import { MAX_DUMP_RECORD_BYTES } from './dumps-bytes.ts';
import { MAX_COMPARISON_PARTS_PER_RECORD } from './plan-comparison-store.ts';

export type ComparisonDomain =
  | 'fact'
  | 'qualifier'
  | 'reference'
  | 'term'
  | 'media'
  | 'statistic'
  | 'metadata'
  | 'digest'
  | 'target'
  | 'classification';

export type ProjectionPart = Readonly<{
  address: string;
  domain: ComparisonDomain;
  change: 'added' | 'removed' | 'changed' | 'unchanged';
  before: unknown;
  after: unknown;
}>;

export type SideProjection = Readonly<{
  recordKey: string;
  kind: string;
  recordRevision: string;
  digest: string;
  converterRevision: string;
  skipped: boolean;
  display: unknown;
  operations: unknown;
  provenance: unknown;
  diagnostics: unknown;
}>;

export type ProjectionDiff = Readonly<{
  parts: readonly ProjectionPart[];
  truncated: boolean;
  retainedEqual: boolean;
  digestDiffers: boolean;
  converterDiffers: boolean;
  revisionDiffers: boolean;
  skippedDiffers: boolean;
  unavailable: boolean;
}>;

const SECRET = /password|secret|token|credential/i;
const SKIP_KEYS = new Set(['sourceUrl', 'url']);

function boundedJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > MAX_DUMP_RECORD_BYTES)
    throw new RangeError('Comparison projection exceeds its bound.');
  return text;
}

export function parseJsonField(
  value: string,
  label: string,
): { ok: true; value: unknown } | { ok: false; label: string } {
  if (Buffer.byteLength(value, 'utf8') > MAX_DUMP_RECORD_BYTES) return { ok: false, label };
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false, label };
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (SKIP_KEYS.has(key) || SECRET.test(key)) continue;
    result[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return result;
}

export function canonicalJson(value: unknown): string {
  return boundedJson(sortKeys(value));
}

function equalJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function propertyId(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0 && value.length <= 255) return value;
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { id?: unknown }).id === 'string')
    return (value as { id: string }).id;
  return null;
}

export function valueDiscriminator(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return `${typeof value}:${String(value)}`;
  if (Array.isArray(value)) return `array:${value.length}`;
  const record = value as Record<string, unknown>;
  if (record.type === 'somevalue' || record.type === 'novalue') return String(record.type);
  if (record.type === 'value') return `value:${valueDiscriminator(record.content)}`;
  if (record.kind === 'document' && typeof record.digest === 'string') return `document:${record.digest}`;
  if (record.kind === 'unresolved-or-bound-target')
    return `target:${record.present === true ? 'present' : 'unresolved'}`;
  if (typeof record.amount === 'string' && typeof record.unit === 'string')
    return `quantity:${record.amount}:${record.unit}:${typeof record.lowerBound === 'string' ? record.lowerBound : ''}:${typeof record.upperBound === 'string' ? record.upperBound : ''}`;
  if (typeof record.time === 'string' && typeof record.precision === 'number')
    return `time:${record.time}:${record.precision}`;
  if (typeof record.text === 'string' && typeof record.language === 'string')
    return `term:${record.language}:${record.text}`;
  if (typeof record.id === 'string') return `id:${record.id}:${valueDiscriminator(record.content ?? record.value)}`;
  return canonicalJson(record);
}

function operationFamily(operation: Record<string, unknown>): string {
  const field = typeof operation.fieldGroup === 'string' ? operation.fieldGroup : 'unknown';
  if (operation.operation === 'create') return `create:${field}`;
  if (operation.operation === 'retract') return `retract:${field}`;
  const property = propertyId(operation.property) ?? 'unknown';
  return `propose:${field}:${property}`;
}

function itemKey(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const property = propertyId(record.property);
  if (property) return `snak:${property}:${valueDiscriminator(record.value ?? record.content)}`;
  if (typeof record.language === 'string' && typeof record.text === 'string')
    return `term:${record.language}:${record.text}`;
  if (typeof record.language === 'string' && typeof record.value === 'string')
    return `term:${record.language}:${record.value}`;
  if (record.kind === 'media-intent')
    return `media:${String(record.role)}:${String(record.license)}:${String(record.rightsHolder)}`;
  if (Array.isArray(record.parts)) return `group:${canonicalJson(record.parts)}`;
  return null;
}

class PartBuffer {
  readonly parts: ProjectionPart[] = [];
  truncated = false;
  push(part: ProjectionPart): void {
    if (this.truncated) return;
    if (this.parts.length >= MAX_COMPARISON_PARTS_PER_RECORD) {
      this.truncated = true;
      return;
    }
    this.parts.push(part);
  }
}

function domainForAddress(address: string, fallback: ComparisonDomain): ComparisonDomain {
  if (address.includes('/qualifiers/')) return 'qualifier';
  if (address.includes('/references/')) return 'reference';
  if (address.startsWith('terms/')) return 'term';
  if (address.startsWith('media/')) return 'media';
  if (address.startsWith('statistic')) return 'statistic';
  if (address.startsWith('metadata')) return 'metadata';
  if (address.startsWith('digest') || address.startsWith('converter') || address.startsWith('revision'))
    return 'digest';
  if (address.includes('unresolved') || address.includes('/target')) return 'target';
  if (address.startsWith('skipped')) return 'classification';
  return fallback;
}

function emit(buffer: PartBuffer, address: string, domain: ComparisonDomain, before: unknown, after: unknown): void {
  const change =
    before === undefined
      ? 'added'
      : after === undefined
        ? 'removed'
        : equalJson(before, after)
          ? 'unchanged'
          : 'changed';
  if (change === 'unchanged') return;
  buffer.push({ address, domain: domainForAddress(address, domain), change, before, after });
}

function diffOrdered(
  buffer: PartBuffer,
  address: string,
  domain: ComparisonDomain,
  left: unknown[],
  right: unknown[],
): void {
  const leftUsed = new Uint8Array(left.length);
  const rightUsed = new Uint8Array(right.length);
  for (let i = 0; i < left.length; i++) {
    const key = itemKey(left[i]) ?? canonicalJson(left[i]);
    for (let j = 0; j < right.length; j++) {
      if (rightUsed[j]) continue;
      const other = itemKey(right[j]) ?? canonicalJson(right[j]);
      if (key === other && equalJson(left[i], right[j])) {
        leftUsed[i] = 1;
        rightUsed[j] = 1;
        break;
      }
    }
  }
  let added = 0;
  let removed = 0;
  for (let i = 0; i < left.length; i++) {
    if (leftUsed[i]) continue;
    emit(buffer, `${address}/${removed}`, domain, left[i], undefined);
    removed += 1;
  }
  for (let j = 0; j < right.length; j++) {
    if (rightUsed[j]) continue;
    emit(buffer, `${address}/+${added}`, domain, undefined, right[j]);
    added += 1;
  }
}

function diffValue(buffer: PartBuffer, address: string, domain: ComparisonDomain, left: unknown, right: unknown): void {
  if (left === undefined && right === undefined) return;
  if (left === undefined || right === undefined) {
    emit(buffer, address, domain, left, right);
    return;
  }
  if (equalJson(left, right)) return;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (
      left.every((item) => typeof item !== 'object' || item === null) &&
      right.every((item) => typeof item !== 'object' || item === null)
    ) {
      if (equalJson(left, right)) return;
      emit(buffer, address, domain, left, right);
      return;
    }
    diffOrdered(buffer, address, domain, left, right);
    return;
  }
  if (
    left &&
    right &&
    typeof left === 'object' &&
    typeof right === 'object' &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    if (
      leftRecord.type !== rightRecord.type &&
      (leftRecord.type === 'somevalue' ||
        rightRecord.type === 'somevalue' ||
        leftRecord.type === 'novalue' ||
        rightRecord.type === 'novalue')
    ) {
      emit(buffer, `${address}/discriminator`, domain, leftRecord.type, rightRecord.type);
    }
    const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
    for (const key of [...keys].sort()) {
      if (SKIP_KEYS.has(key) || SECRET.test(key)) continue;
      const nextDomain =
        key === 'qualifiers'
          ? 'qualifier'
          : key === 'references' || key === 'parts'
            ? 'reference'
            : key === 'labels' || key === 'aliases' || key === 'descriptions'
              ? 'term'
              : domain;
      diffValue(buffer, `${address}/${key}`, nextDomain, leftRecord[key], rightRecord[key]);
    }
    return;
  }
  emit(buffer, address, domain, left, right);
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function unresolved(operation: Record<string, unknown>): boolean {
  if (operation.unresolvedTarget === true) return true;
  const subject = asRecord(operation.subject);
  if (subject?.kind === 'unresolved-or-bound-target' && subject.present !== true) return true;
  return false;
}

function diffOperations(buffer: PartBuffer, left: unknown, right: unknown): void {
  const leftOps = asArray(left) ?? [];
  const rightOps = asArray(right) ?? [];
  const leftRecords = leftOps.map((item, index) => ({ index, value: asRecord(item) }));
  const rightRecords = rightOps.map((item, index) => ({ index, value: asRecord(item) }));
  if (leftRecords.some((item) => !item.value) || rightRecords.some((item) => !item.value)) {
    emit(buffer, 'operations', 'fact', left, right);
    return;
  }
  const leftUsed = new Uint8Array(leftRecords.length);
  const rightUsed = new Uint8Array(rightRecords.length);
  const leftKeys = leftRecords.map((item) => operationFamily(item.value!));
  const rightKeys = rightRecords.map((item) => operationFamily(item.value!));
  const pairChanged = (i: number, j: number) => {
    leftUsed[i] = 1;
    rightUsed[j] = 1;
    const leftOp = leftRecords[i]!.value!;
    const rightOp = rightRecords[j]!.value!;
    const address = `op/${leftKeys[i]}/${i}`;
    if (unresolved(leftOp) || unresolved(rightOp)) {
      emit(
        buffer,
        `${address}/target`,
        'target',
        unresolved(leftOp) ? 'unresolved' : 'present',
        unresolved(rightOp) ? 'unresolved' : 'present',
      );
    }
    diffValue(buffer, `${address}/value`, 'fact', leftOp.value, rightOp.value);
    diffValue(buffer, `${address}/qualifiers`, 'qualifier', leftOp.qualifiers, rightOp.qualifiers);
    diffValue(buffer, `${address}/references`, 'reference', leftOp.references, rightOp.references);
    diffValue(buffer, `${address}/labels`, 'term', leftOp.labels, rightOp.labels);
    if (typeof leftOp.subjectType === 'string' || typeof rightOp.subjectType === 'string')
      emit(buffer, `${address}/subjectType`, 'fact', leftOp.subjectType, rightOp.subjectType);
  };
  for (let i = 0; i < leftRecords.length; i++) {
    for (let j = 0; j < rightRecords.length; j++) {
      if (rightUsed[j] || leftKeys[i] !== rightKeys[j]) continue;
      if (!equalJson(leftRecords[i]!.value, rightRecords[j]!.value)) continue;
      leftUsed[i] = 1;
      rightUsed[j] = 1;
      break;
    }
  }
  for (let i = 0; i < leftRecords.length; i++) {
    if (leftUsed[i]) continue;
    const sameFamily = rightRecords.map((item, j) => j).filter((j) => !rightUsed[j] && rightKeys[j] === leftKeys[i]);
    if (sameFamily.length !== 1) continue;
    const remainingLeft = leftRecords
      .map((item, index) => index)
      .filter((index) => !leftUsed[index] && leftKeys[index] === leftKeys[i]);
    if (remainingLeft.length !== 1) continue;
    pairChanged(i, sameFamily[0]!);
  }
  for (let i = 0; i < leftRecords.length; i++) {
    if (leftUsed[i]) continue;
    emit(buffer, `op/${leftKeys[i]}/${i}`, 'fact', leftRecords[i]!.value, undefined);
  }
  for (let j = 0; j < rightRecords.length; j++) {
    if (rightUsed[j]) continue;
    emit(buffer, `op/${rightKeys[j]}/+${j}`, 'fact', undefined, rightRecords[j]!.value);
  }
}

function diffTerms(buffer: PartBuffer, address: string, left: unknown, right: unknown): void {
  const leftRecord = asRecord(left) ?? {};
  const rightRecord = asRecord(right) ?? {};
  const languages = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
  for (const language of [...languages].sort()) {
    const leftValue = leftRecord[language];
    const rightValue = rightRecord[language];
    if (Array.isArray(leftValue) || Array.isArray(rightValue)) {
      diffValue(buffer, `${address}/${language}`, 'term', leftValue ?? [], rightValue ?? []);
      continue;
    }
    const leftText = asRecord(leftValue)?.value ?? asRecord(leftValue)?.text ?? leftValue;
    const rightText = asRecord(rightValue)?.value ?? asRecord(rightValue)?.text ?? rightValue;
    if (!equalJson(leftText, rightText)) emit(buffer, `${address}/${language}`, 'term', leftText, rightText);
  }
}

function diffNormalized(buffer: PartBuffer, left: unknown, right: unknown): void {
  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  if (!leftRecord && !rightRecord) return;
  if (!leftRecord || !rightRecord) {
    emit(buffer, 'normalized', 'fact', left, right);
    return;
  }
  diffTerms(buffer, 'terms/labels', leftRecord.labels, rightRecord.labels);
  diffTerms(buffer, 'terms/aliases', leftRecord.aliases, rightRecord.aliases);
  diffTerms(buffer, 'terms/descriptions', leftRecord.descriptions, rightRecord.descriptions);
  const leftClaims = asRecord(leftRecord.claims) ?? {};
  const rightClaims = asRecord(rightRecord.claims) ?? {};
  const properties = new Set([...Object.keys(leftClaims), ...Object.keys(rightClaims)]);
  for (const property of [...properties].sort()) {
    diffValue(buffer, `claims/${property}`, 'fact', leftClaims[property] ?? [], rightClaims[property] ?? []);
  }
  const skip = new Set(['labels', 'aliases', 'descriptions', 'claims', 'id', 'type', 'lastrevid', 'key', 'revision']);
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
  for (const key of [...keys].sort()) {
    if (skip.has(key) || SKIP_KEYS.has(key) || SECRET.test(key)) continue;
    diffValue(buffer, `normalized/${key}`, 'fact', leftRecord[key], rightRecord[key]);
  }
}

function diffDisplay(buffer: PartBuffer, left: unknown, right: unknown): void {
  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  if (!leftRecord && !rightRecord) return;
  if (!leftRecord || !rightRecord) {
    emit(buffer, 'display', 'fact', left, right);
    return;
  }
  diffNormalized(buffer, leftRecord.normalized, rightRecord.normalized);
  diffValue(buffer, 'media', 'media', leftRecord.mediaIntents ?? [], rightRecord.mediaIntents ?? []);
  if (leftRecord.sourceStatistic !== undefined || rightRecord.sourceStatistic !== undefined)
    emit(buffer, 'statistic', 'statistic', leftRecord.sourceStatistic, rightRecord.sourceStatistic);
  if (leftRecord.ignored !== rightRecord.ignored)
    emit(buffer, 'ignored', 'classification', leftRecord.ignored, rightRecord.ignored);
}

export function compareRetainedProjections(left: SideProjection | null, right: SideProjection | null): ProjectionDiff {
  const buffer = new PartBuffer();
  if (!left && !right)
    return {
      parts: [],
      truncated: false,
      retainedEqual: true,
      digestDiffers: false,
      converterDiffers: false,
      revisionDiffers: false,
      skippedDiffers: false,
      unavailable: false,
    };
  if (!left || !right) {
    return {
      parts: [
        {
          address: 'presence',
          domain: 'fact',
          change: left ? 'removed' : 'added',
          before: left ? { recordKey: left.recordKey } : undefined,
          after: right ? { recordKey: right.recordKey } : undefined,
        },
      ],
      truncated: false,
      retainedEqual: false,
      digestDiffers: Boolean(left?.digest && right?.digest && left.digest !== right.digest),
      converterDiffers: Boolean(
        left?.converterRevision && right?.converterRevision && left.converterRevision !== right.converterRevision,
      ),
      revisionDiffers: Boolean(
        left?.recordRevision && right?.recordRevision && left.recordRevision !== right.recordRevision,
      ),
      skippedDiffers: Boolean(left && right && left.skipped !== right.skipped),
      unavailable: false,
    };
  }
  const digestDiffers = left.digest !== right.digest;
  const converterDiffers = left.converterRevision !== right.converterRevision;
  const revisionDiffers = left.recordRevision !== right.recordRevision;
  const skippedDiffers = left.skipped !== right.skipped;
  if (digestDiffers) emit(buffer, 'digest', 'digest', left.digest, right.digest);
  if (converterDiffers) emit(buffer, 'converter', 'digest', left.converterRevision, right.converterRevision);
  if (revisionDiffers) emit(buffer, 'revision', 'digest', left.recordRevision, right.recordRevision);
  if (skippedDiffers) emit(buffer, 'skipped', 'classification', left.skipped, right.skipped);
  diffOperations(buffer, left.operations, right.operations);
  diffDisplay(buffer, left.display, right.display);
  const retainedEqual = equalJson(left.operations, right.operations) && equalJson(left.display, right.display);
  if (digestDiffers && retainedEqual) {
    emit(buffer, 'retained-limit', 'digest', 'digest-or-revision-differs', 'retained-rendered-fields-equal');
  }
  return {
    parts: buffer.parts,
    truncated: buffer.truncated,
    retainedEqual,
    digestDiffers,
    converterDiffers,
    revisionDiffers,
    skippedDiffers,
    unavailable: false,
  };
}

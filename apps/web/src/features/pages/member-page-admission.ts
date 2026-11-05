import type { PageRead } from '@rezics/composition';
import type { Section } from './overview';
import { isRecord } from './shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nativeId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function nativeType(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function nativeLabels(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((label) => typeof label === 'string');
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function nativeCover(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !nativeId(value.media) ||
    !positiveInteger(value.width) ||
    !positiveInteger(value.height) ||
    !isRecord(value.placeholder) ||
    typeof value.placeholder.thumbhash !== 'string' ||
    typeof value.placeholder.color !== 'string' ||
    !Array.isArray(value.variants) ||
    !value.variants.every(
      (variant) =>
        isRecord(variant) && (variant.format === 'avif' || variant.format === 'webp') && positiveInteger(variant.width),
    ) ||
    !(
      value.focalPoint === null ||
      (isRecord(value.focalPoint) &&
        typeof value.focalPoint.x === 'number' &&
        Number.isFinite(value.focalPoint.x) &&
        typeof value.focalPoint.y === 'number' &&
        Number.isFinite(value.focalPoint.y))
    ) ||
    !isRecord(value.credit) ||
    typeof value.credit.rightsHolder !== 'string' ||
    !isRecord(value.credit.via) ||
    typeof value.credit.via.name !== 'string' ||
    typeof value.credit.via.url !== 'string' ||
    typeof value.credit.license !== 'string' ||
    !Array.isArray(value.credit.obligations) ||
    !value.credit.obligations.every((obligation) => typeof obligation === 'string')
  )
    return false;
  return true;
}

/** Kernel subject summary: identity, type, types, label, creativeWork and cover. */
function nativeSummary(value: unknown, id: string): boolean {
  return (
    isRecord(value) &&
    nativeId(value.id) &&
    value.id.toLowerCase() === id.toLowerCase() &&
    nativeType(value.type) &&
    Array.isArray(value.types) &&
    value.types.every(nativeType) &&
    value.types.includes(value.type) &&
    (value.label === null ||
      (isRecord(value.label) && typeof value.label.value === 'string' && typeof value.label.language === 'string')) &&
    typeof value.creativeWork === 'boolean' &&
    (value.cover === null || nativeCover(value.cover))
  );
}

function boundSummary(value: unknown, id: string): boolean {
  return value === undefined || value === null || nativeSummary(value, id);
}

function nativeFact(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === 'item') return nativeId(value.id) && nativeLabels(value.labels);
  if (value.kind === 'time') return Number.isInteger(value.year);
  if (value.kind === 'quantity')
    return typeof value.amount === 'number' && Number.isFinite(value.amount) && typeof value.unit === 'string';
  if (value.kind === 'code') return typeof value.value === 'string';
  return false;
}

function nativeFacts(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return Object.values(value).every((facts) => Array.isArray(facts) && facts.every(nativeFact));
}

function plannedLimit(read: PageRead): number | undefined {
  const limit = read.kind === 'search' ? read.body.limit : read.kind === 'members' ? read.limit : undefined;
  return typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 ? limit : undefined;
}

function nativeEnvelope(body: Record<string, unknown>, rows: unknown): boolean {
  return (
    Array.isArray(rows) &&
    (body.next === undefined || body.next === null || (typeof body.next === 'string' && body.next.length > 0))
  );
}

function nativeMemberRow(row: unknown): boolean {
  return (
    isRecord(row) &&
    nativeId(row.subjectId) &&
    (row.kind === undefined || row.kind === 'dynamic') &&
    boundSummary(row.subject, row.subjectId) &&
    boundSummary(row.summary, row.subjectId) &&
    nativeFacts(row.facts)
  );
}

function nativeSearchRow(row: unknown): boolean {
  return (
    isRecord(row) &&
    nativeId(row.id) &&
    nativeType(row.type) &&
    nativeLabels(row.labels) &&
    Object.hasOwn(row, 'summary') &&
    (row.summary === null ||
      (isRecord(row.summary) && nativeSummary(row.summary, row.id) && row.summary.type === row.type)) &&
    nativeFacts(row.facts)
  );
}

/** Admit one native members/search page against its planned descriptor; never a sliced prefix. */
export function admitMemberPage(read: PageRead, body: Record<string, unknown>): Record<string, unknown> | undefined {
  const limit = plannedLimit(read);
  if (limit === undefined) return;
  const rows = read.kind === 'search' ? body.subjects : read.kind === 'members' ? body.members : undefined;
  if (!nativeEnvelope(body, rows) || !Array.isArray(rows) || rows.length > limit) return;
  const admit = read.kind === 'search' ? nativeSearchRow : nativeMemberRow;
  return rows.every(admit) ? body : undefined;
}

export function admitMemberSection(section: Section): Section {
  if (!section.ok) return section;
  return admitMemberPage(section.read, section.body) ? section : { ok: false, status: 422 };
}

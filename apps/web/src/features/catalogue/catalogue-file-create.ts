import type { KernelClient } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { checkSubjectInput, type Violation } from '@rezics/definitions/validate';
import type { SessionEnv } from '../../session/client';
import { editableScalar, creationStatement, type SnakInput, type StatementInput } from './statement-editor';
import { createSubjectRecord } from './create-subject-request';
import {
  type CreateResult,
  type CreateSubjectCommand,
  type CreatedReader,
  type InitialSubject,
} from './create-subject';
import {
  admittedProperty,
  codecProperty,
  fileGroups,
  hashProperty,
  isCatalogueFileType,
  isFileOrGroupType,
  isReleaseGroupType,
  type FileGroupId,
} from './catalogue-file-profile/model';
import { statementHolderKey } from './statement-editor-view';
import { controlId, presentStatementViolations } from './statement-validation-presentation';
import {
  applyReuse,
  captureReuse,
  cloneReferenceGroup,
  type ReuseCapture,
  type ReuseRefusal,
  type ReuseSource,
} from './reference-reuse';
import { factHolder, type FactDraft } from './subject-facts';
import { m } from '../../paraglide/messages.js';

export type CatalogueFileCreateRead = { ok: true; digest: string; release: Release } | { ok: false };
export type CatalogueFileCreateFact = { key: string; statement: StatementInput };
export type CatalogueFileCreateItem = InitialSubject & { statements: Record<string, StatementInput[]> };
export type CatalogueFileCreateCommand = { key: string; item: CatalogueFileCreateItem };
export type CatalogueFileCreateReuse = {
  source: ReuseSource;
  selected: string[];
  capture: ReuseCapture;
  applied: { holder: string; property: string; index: number }[];
  refused: { holder: string; property: string; reason: ReuseRefusal }[];
};
export type CatalogueFileCreateHolder = { key: string; property: string; statement: StatementInput };
export type CatalogueFileCreateGrain = 'file' | 'group';

const termProperties = new Set(['schema:name', 'schema:description', 'schema:alternateName']);
const hashIds = new Set(['schema:sha256', 'rezics:ed2k', 'rezics:crc32', 'wdt:P4092']);
export const catalogueFileCreateUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nativePartShape(value: unknown): value is Record<string, unknown> {
  return (
    record(value) &&
    record(value.property) &&
    typeof value.property.id === 'string' &&
    record(value.value) &&
    ['value', 'somevalue', 'novalue'].includes(String(value.value.type))
  );
}

function creationStatementMap(value: unknown): value is Record<string, StatementInput[]> {
  return (
    record(value) &&
    Object.values(value).every(
      (rows) =>
        Array.isArray(rows) &&
        rows.every(
          (row) =>
            nativePartShape(row) &&
            (row.qualifiers === undefined ||
              (Array.isArray(row.qualifiers) && row.qualifiers.every(nativePartShape))) &&
            Array.isArray(row.references) &&
            row.references.every(
              (group) => record(group) && Array.isArray(group.parts) && group.parts.every(nativePartShape),
            ),
        ),
    )
  );
}

/** File grain wins when a Type is both a catalogue file and a release group. */
export function catalogueFileCreateGrain(release: Release, type: string): CatalogueFileCreateGrain | undefined {
  if (isCatalogueFileType(release, type)) return 'file';
  if (isReleaseGroupType(release, type)) return 'group';
  return undefined;
}

/** Only Types in the exact release that classify as a file or release-group grain are offered. */
export function catalogueFileCreateTypes(release: Release, locale: string) {
  return Object.keys(release.types)
    .filter((id) => isFileOrGroupType(release, id))
    .map((id) => {
      const definition = release.types[id]!;
      const labels = pickText(definition.labels ?? {}, locale);
      const descriptions = pickText(definition.descriptions ?? {}, locale);
      const bases = (definition.bases ?? []).filter((base) => typeof base === 'string' && base.length > 0);
      const grain = catalogueFileCreateGrain(release, id)!;
      return {
        id,
        label: labels.text || id,
        description: descriptions.text,
        grain,
        ...(labels.lang ? { labelLanguage: labels.lang } : {}),
        ...(descriptions.lang ? { descriptionLanguage: descriptions.lang } : {}),
        ...(bases.length ? { bases } : {}),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label, locale));
}

function admittedCreateProperty(release: Release, type: string, id: string): boolean {
  const definition = release.properties[id];
  if (!definition || termProperties.has(id) || !admittedProperty(release, type, id)) return false;
  if (definition.datatype === 'wikibase-item')
    return !!definition.relation && Array.isArray(definition.targets) && definition.targets.length > 0;
  return editableScalar(definition);
}

/** The exact descriptor and fileGroups control the field list; labels are not admission. */
export function catalogueFileCreateFields(release: Release, type: string): string[] {
  if (!isFileOrGroupType(release, type)) return [];
  const seen = new Set<string>();
  const fields: string[] = [];
  for (const ids of Object.values(fileGroups(release, type))) {
    for (const id of ids) {
      if (seen.has(id) || !admittedCreateProperty(release, type, id)) continue;
      seen.add(id);
      fields.push(id);
    }
  }
  return fields;
}

const groupOrder: { id: FileGroupId; message: (locale: string) => string }[] = [
  { id: 'identifiers', message: (locale) => m.catalogue_file_identifiers({}, { locale: locale as never }) },
  { id: 'technical', message: (locale) => m.catalogue_file_technical({}, { locale: locale as never }) },
  { id: 'language', message: (locale) => m.catalogue_file_language({}, { locale: locale as never }) },
  { id: 'group', message: (locale) => m.catalogue_file_group({}, { locale: locale as never }) },
  { id: 'credits', message: (locale) => m.catalogue_file_creator_credits({}, { locale: locale as never }) },
  { id: 'relations', message: (locale) => m.catalogue_file_related({}, { locale: locale as never }) },
  { id: 'facts', message: (locale) => m.catalogue_file_create_facts({}, { locale: locale as never }) },
];

export function catalogueFileCreateFieldGroups(
  release: Release,
  type: string,
  locale: string,
): { label: string; properties: string[] }[] {
  const admitted = new Set(catalogueFileCreateFields(release, type));
  const groups = fileGroups(release, type);
  return groupOrder
    .map(({ id, message }) => ({
      label: message(locale),
      properties: groups[id].filter((property) => admitted.has(property)),
    }))
    .filter((group) => group.properties.length > 0);
}

export function catalogueFileCreateHashNotice(
  release: Release,
  type: string,
  property: string,
): 'hash' | 'codec' | undefined {
  if (hashIds.has(property) || hashProperty(release, type) === property) return 'hash';
  if (property === 'schema:encodingFormat' || codecProperty(release, type) === property) return 'codec';
  return undefined;
}

function hasNativeContent(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some(hasNativeContent);
  if (value && typeof value === 'object')
    return Object.entries(value).some(
      ([key, part]) => !['unit', 'precision', 'calendarmodel', 'language'].includes(key) && hasNativeContent(part),
    );
  return false;
}

function hasEnteredValue(part: SnakInput): boolean {
  return part.value.type !== 'value' || hasNativeContent(part.value.content);
}

/** Untouched native controls are omitted. Entered malformed values remain in the item for validation. */
function hasEnteredStatement(statement: StatementInput): boolean {
  return (
    hasEnteredValue(statement) ||
    (statement.qualifiers ?? []).some(hasEnteredValue) ||
    statement.references.some((reference) => reference.parts.some(hasEnteredValue))
  );
}

export function catalogueFileCreatePreparedFacts(
  facts: readonly CatalogueFileCreateFact[],
  release: Release,
): CatalogueFileCreateFact[] {
  return facts.flatMap((row) => {
    const statement = creationStatement(row.statement, release);
    return hasEnteredStatement(statement) ? [{ key: row.key, statement }] : [];
  });
}

export function catalogueFileCreateDraft(
  release: Release,
  initial: InitialSubject,
  facts: readonly CatalogueFileCreateFact[],
): { item: CatalogueFileCreateItem; errors: Violation[] } {
  const item: CatalogueFileCreateItem = { ...initial, statements: {} };
  const errors: Violation[] = [];
  for (const row of catalogueFileCreatePreparedFacts(facts, release)) {
    const statement = row.statement;
    const property = statement.property.id;
    (item.statements[property] ??= []).push(statement);
  }
  errors.push(...checkSubjectInput(item, release).violations);
  if (!isFileOrGroupType(release, item.type)) errors.push({ pointer: '/type', code: 'unsupported' });
  const admitted = catalogueFileCreateFields(release, item.type);
  for (const [property, statements] of Object.entries(item.statements)) {
    if (!admitted.includes(property)) errors.push({ pointer: `/statements/${property}`, code: 'unsupported' });
    if (statements.some((statement) => statement.property.id !== property))
      errors.push({ pointer: `/statements/${property}`, code: 'invalid_format' });
    statements.forEach((statement, index) => {
      if (statement.rank !== 'normal')
        errors.push({ pointer: `/statements/${property}/${index}/rank`, code: 'unsupported' });
    });
  }
  return { item, errors };
}

export async function readCatalogueFileCreate(client: KernelClient): Promise<CatalogueFileCreateRead> {
  try {
    const active = await client.definitions.active.get();
    if (active.status !== 200 || !active.data || typeof active.data.digest !== 'string') return { ok: false };
    const result = await client.definitions.releases({ digest: active.data.digest }).get();
    if (result.status !== 200 || !result.data || result.data.digest !== active.data.digest) return { ok: false };
    const release = result.data.release as Release;
    if (!release.types || !release.properties) return { ok: false };
    return { ok: true, digest: active.data.digest, release };
  } catch {
    return { ok: false };
  }
}

/** Fresh sends are admitted against the current immutable release, then use the ordinary native subject POST. */
export async function createCatalogueFile(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  command: CreateSubjectCommand,
  locale: string,
  preparedAuthorization?: string,
): Promise<CreateResult> {
  const read = await readCatalogueFileCreate(client);
  if (!read.ok) return { ok: false, reason: 'unavailable' };
  const item = command.item as CatalogueFileCreateItem;
  if (!creationStatementMap(item.statements))
    return {
      ok: false,
      reason: 'invalid',
      errors: [{ pointer: '/statements', code: 'invalid_format' }],
    };
  const nativeErrors = checkSubjectInput(item, read.release).violations;
  if (nativeErrors.length) return { ok: false, reason: 'invalid', errors: nativeErrors, refreshDefinitions: true };
  const statements = item.statements ?? {};
  if (
    Object.entries(statements).some(([property, rows]) => rows.some((statement) => statement.property.id !== property))
  )
    return { ok: false, reason: 'invalid', errors: [{ pointer: '/statements', code: 'invalid_format' }] };
  const facts = Object.entries(statements).flatMap(([property, rows]) =>
    rows.map((statement, index) => ({ key: `${property}:${index}`, statement })),
  );
  const errors = catalogueFileCreateDraft(read.release, item, facts).errors;
  if (errors.length) return { ok: false, reason: 'invalid', errors, refreshDefinitions: true };
  const created = await createSubjectRecord(client, request, sessionEnv, command, locale, preparedAuthorization);
  return created.ok
    ? {
        ...created,
        reader: catalogueFileCreateAdmitReader(created.reader, created.id, read.release, item.type),
      }
    : created;
}

export function catalogueFileCreateHolder(key: string): string {
  return `catalogue-file-initial-${key}`;
}

export function catalogueFileCreateHolders(facts: readonly CatalogueFileCreateFact[]): CatalogueFileCreateHolder[] {
  return facts.map((row) => ({ key: row.key, property: row.statement.property.id, statement: row.statement }));
}

export function catalogueFileCreateFactDrafts(
  facts: readonly CatalogueFileCreateFact[],
  release: Release,
  type: string,
): FactDraft[] {
  const admitted = new Set(catalogueFileCreateFields(release, type));
  return facts.map((row) => {
    const property = row.statement.property.id;
    const definition = release.properties[property];
    const reusable = admitted.has(property);
    return {
      holder: catalogueFileCreateHolder(row.key),
      property,
      source: null,
      baseline: null,
      statement: row.statement,
      included: true,
      ...(!reusable ? { reuseBlocked: definition ? ('withdrawn' as const) : ('unknown' as const) } : {}),
    };
  });
}

export function captureCatalogueFileCreateReuse(
  facts: readonly CatalogueFileCreateFact[],
  key: string,
  groupIndex: number,
  release: Release,
  type: string,
): CatalogueFileCreateReuse | null {
  const row = facts.find((item) => item.key === key);
  const group = row && groupIndex >= 0 ? row.statement.references[groupIndex] : undefined;
  if (!row || !group) return null;
  const source = {
    holder: catalogueFileCreateHolder(row.key),
    property: row.statement.property.id,
    groupIndex,
    snapshot: cloneReferenceGroup(group),
  };
  return {
    source,
    selected: [],
    capture: captureReuse(source, catalogueFileCreateFactDrafts(facts, release, type)),
    applied: [],
    refused: [],
  };
}

export function applyCatalogueFileCreateReuse(
  facts: readonly CatalogueFileCreateFact[],
  reuse: CatalogueFileCreateReuse,
  release: Release,
  type: string,
): { facts: CatalogueFileCreateFact[]; reuse: CatalogueFileCreateReuse } {
  const drafts = catalogueFileCreateFactDrafts(facts, release, type);
  const result = applyReuse(drafts, reuse.source, reuse.selected, release);
  const byHolder = new Map(facts.map((row) => [catalogueFileCreateHolder(row.key), row.key]));
  return {
    facts: result.drafts.flatMap((draft) => {
      const key = byHolder.get(factHolder(draft));
      return key ? [{ key, statement: draft.statement }] : [];
    }),
    reuse: { ...reuse, applied: result.applied, refused: result.refused },
  };
}

export function refreshCatalogueFileCreateReuse(
  facts: readonly CatalogueFileCreateFact[],
  reuse: CatalogueFileCreateReuse,
  release: Release,
  type: string,
): CatalogueFileCreateReuse | null {
  const row = facts.find((item) => catalogueFileCreateHolder(item.key) === reuse.source.holder);
  const group = row?.statement.references[reuse.source.groupIndex];
  if (!row || !group) return null;
  const source = {
    ...reuse.source,
    property: row.statement.property.id,
    snapshot: cloneReferenceGroup(group),
  };
  return {
    ...reuse,
    source,
    capture: captureReuse(source, catalogueFileCreateFactDrafts(facts, release, type)),
    applied: [],
    refused: [],
  };
}

export function catalogueFileCreateStructuredParts(facts: readonly CatalogueFileCreateFact[]): number {
  let count = 0;
  for (const row of facts) {
    count += 1 + (row.statement.qualifiers?.length ?? 0);
    for (const group of row.statement.references) count += group.parts.length;
  }
  return count;
}

export function visitCatalogueFileCreateParts(
  facts: readonly CatalogueFileCreateFact[],
  visit: (part: SnakInput) => void,
): number {
  let count = 0;
  for (const row of facts) {
    visit(row.statement);
    count += 1;
    for (const part of row.statement.qualifiers ?? []) {
      visit(part);
      count += 1;
    }
    for (const group of row.statement.references) {
      for (const part of group.parts) {
        visit(part);
        count += 1;
      }
    }
  }
  return count;
}

function decodePointer(pointer: string): string[] | undefined {
  if (!pointer.startsWith('/') || /~(?![01])/.test(pointer)) return;
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function currentFact(holder: CatalogueFileCreateHolder, facts: readonly CatalogueFileCreateFact[]) {
  return facts.find((row) => row.key === holder.key && row.statement.property.id === holder.property);
}

function nestedControl(
  tail: string[],
  row: CatalogueFileCreateHolder,
  release: Release,
  locale: string,
): { id: string; label: string } | undefined {
  const id = catalogueFileCreateHolder(row.key);
  const o = { locale: locale as never };
  const property = row.property;
  const label = pickText(release.properties[property]?.labels ?? {}, locale).text || property;
  let part: SnakInput = row.statement;
  let address = 'fact';
  let section = '';
  if (tail[0] === 'qualifiers' && /^(0|[1-9]\d*)$/.test(tail[1] ?? '')) {
    const qualifier = row.statement.qualifiers?.[Number(tail[1])];
    if (!qualifier) return { id: `${id}-qualifiers`, label: `${label} · ${m.correction_qualifiers({}, o)}` };
    part = qualifier;
    address = `qualifier-${tail[1]}`;
    section = `${m.correction_qualifiers({}, o)} ${Number(tail[1]) + 1}`;
  } else if (tail[0] === 'references' && tail.length === 1) {
    return { id: `${id}-references`, label: `${label} · ${m.correction_references({}, o)}` };
  } else if (
    tail[0] === 'references' &&
    /^(0|[1-9]\d*)$/.test(tail[1] ?? '') &&
    tail[2] === 'parts' &&
    /^(0|[1-9]\d*)$/.test(tail[3] ?? '')
  ) {
    const reference = row.statement.references[Number(tail[1])]?.parts[Number(tail[3])];
    if (!reference) return { id: `${id}-references`, label: `${label} · ${m.correction_references({}, o)}` };
    part = reference;
    address = `reference-${tail[1]}-part-${tail[3]}`;
    section = `${m.correction_references({}, o)} ${Number(tail[1]) + 1}`;
  } else if (tail[0] === 'value' || tail[0] === 'property' || tail[0] === 'rank' || !tail.length) {
    address = 'fact';
  } else return;
  const suffix = '/' + tail.join('/');
  const path = suffix
    .replace(/^\/qualifiers\/(?:0|[1-9]\d*)/, '')
    .replace(/^\/references\/(?:0|[1-9]\d*)\/parts\/(?:0|[1-9]\d*)/, '');
  if (release.properties[part.property.id]?.datatype === 'wikibase-item') {
    if (path !== '/value/content' && path !== '/value' && path !== '') return;
    const key = part === row.statement ? undefined : statementHolderKey(part);
    const controlAddress = key === undefined ? address : `part-${key}`;
    return { id: controlId(id, controlAddress, 'value'), label: [label, section].filter(Boolean).join(' · ') };
  }
  const presented = presentStatementViolations(
    [{ pointer: `/statement${suffix}`, code: 'invalid_format' }],
    row.statement,
    release,
    locale,
    id,
  )[0];
  if (!presented) return;
  if (part !== row.statement) {
    const key = statementHolderKey(part);
    if (key !== undefined) {
      const field = (
        [
          'state',
          'property',
          'value',
          'date',
          'amount',
          'unit',
          'lowerBound',
          'upperBound',
          'text',
          'language',
        ] as const
      ).find(
        (candidate) =>
          presented.target === controlId(id, address, candidate) || presented.target.endsWith(`-${candidate}`),
      );
      if (field) return { id: controlId(id, `part-${key}`, field), label: [label, presented.label].join(' · ') };
    }
  }
  if (
    presented.target === `${id}-references` ||
    presented.target === `${id}-qualifiers` ||
    presented.target === `${id}-fact` ||
    presented.target.startsWith(`${id}-${address}-`)
  )
    return { id: presented.target, label: [label, presented.label].filter(Boolean).join(' · ') };
}

/** Captured ordinals address the sealed item; removed holders never redirect to a later row. */
export function catalogueFileCreateControl(
  pointer: string,
  captured: readonly CatalogueFileCreateHolder[],
  facts: readonly CatalogueFileCreateFact[],
  type: string,
  release: Release,
  locale: string,
  factsId: string,
): { id: string; label: string } | undefined {
  const segments = decodePointer(pointer);
  if (!segments || segments[0] !== 'statements') return;
  const property = segments[1];
  const fallback =
    pickText(release.properties[property ?? '']?.labels ?? {}, locale).text ||
    property ||
    m.catalogue_file_create_review_facts({}, { locale: locale as never });
  if (!property) return { id: factsId, label: fallback };
  const holders = captured.filter((holder) => holder.property === property);
  const ordinal = segments[2];
  if (ordinal === undefined) {
    if (holders.length !== 1) return { id: factsId, label: fallback };
    const row = currentFact(holders[0]!, facts);
    return row
      ? { id: catalogueFileCreateHolder(row.key), label: fallback }
      : {
          id: `catalogue-file-removed-${holders[0]!.key}`,
          label: `${fallback} · ${m.catalogue_file_create_review_removed({}, { locale: locale as never })}`,
        };
  }
  if (!/^(0|[1-9]\d*)$/.test(ordinal)) return { id: factsId, label: fallback };
  const holder = holders[Number(ordinal)];
  if (!holder) return { id: factsId, label: fallback };
  const row = currentFact(holder, facts);
  if (!row)
    return {
      id: `catalogue-file-removed-${holder.key}`,
      label: `${fallback} · ${m.catalogue_file_create_review_removed({}, { locale: locale as never })}`,
    };
  if (!catalogueFileCreateFields(release, type).includes(property))
    return { id: catalogueFileCreateHolder(row.key), label: fallback };
  return (
    nestedControl(segments.slice(3), holder, release, locale) ?? {
      id: factsId,
      label: m.catalogue_file_create_review_unaddressable({}, { locale: locale as never }),
    }
  );
}

export function catalogueFileCreateUnsupported(item: CatalogueFileCreateItem, release: Release): string[] {
  const admitted = catalogueFileCreateFields(release, item.type);
  return Object.keys(item.statements).filter((property) => !admitted.includes(property));
}

function fileReaderHref(href: string): string {
  const trimmed = href.replace(/\/$/, '');
  return trimmed.endsWith('/file') ? trimmed : `${trimmed}/file`;
}

/** Exact reader identity is kept by CreateSubjectForm; this helper rejects an unrelated success. */
export function catalogueFileCreateAdmitReader(
  reader: CreatedReader,
  id: string,
  release: Release,
  expectedType?: string,
): CreatedReader {
  if (reader.state !== 'ready') return reader;
  if (
    !reader.identity ||
    reader.identity.id !== id ||
    (expectedType !== undefined && reader.identity.type !== expectedType) ||
    !isFileOrGroupType(release, reader.identity.type)
  )
    return { state: 'stale' };
  return { ...reader, href: fileReaderHref(reader.href) };
}

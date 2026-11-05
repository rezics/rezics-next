import type { KernelClient } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { checkSubjectInput, type Violation } from '@rezics/definitions/validate';
import type { SessionEnv } from '../../session/client';
import { typeExtends } from '../pages/graph-browser';
import {
  editableScalar,
  creationStatement,
  emptyCreationStatement,
  type SnakInput,
  type StatementInput,
} from './statement-editor';
import { createSubjectRecord } from './create-subject-request';
import {
  type CreateResult,
  type CreateSubjectCommand,
  type CreateType,
  type CreatedReader,
  type InitialSubject,
} from './create-subject';
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
import { factHolder, factLimit, type FactDraft } from './subject-facts';
import { conceptRequested, conceptTypeAdmitted } from './source-concept-explorer';
import { m } from '../../paraglide/messages.js';

export type ConceptCreateRead = { ok: true; digest: string; release: Release } | { ok: false };
export type ConceptCreateFact = { key: string; statement: StatementInput };
export type ConceptCreateItem = InitialSubject & { statements?: Record<string, StatementInput[]> };
export type ConceptCreateCommand = { key: string; item: ConceptCreateItem };
export type ConceptCreateReuse = {
  source: ReuseSource;
  selected: string[];
  capture: ReuseCapture;
  applied: { holder: string; property: string; index: number }[];
  refused: { holder: string; property: string; reason: ReuseRefusal }[];
};
export type ConceptCreateHolder = { key: string; property: string; statement: StatementInput };
export type ConceptGrain = 'concept' | 'scheme';

const termProperties = new Set(['schema:name', 'schema:description', 'schema:alternateName']);
export const conceptCreateUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const conceptCreatePath = '/catalogue/concept';
const conceptRelationOrder = ['skos:inScheme', 'skos:broader', 'foaf:focus', 'skos:closeMatch'] as const;

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

function hasEnteredStatement(statement: StatementInput): boolean {
  return (
    hasEnteredValue(statement) ||
    (statement.qualifiers ?? []).some(hasEnteredValue) ||
    statement.references.some((reference) => reference.parts.some(hasEnteredValue))
  );
}

/** Concept before Scheme when a Type could match both; admission uses the current structural bases. */
export function conceptGrain(release: Pick<Release, 'types' | 'properties'>, type: string): ConceptGrain | undefined {
  if (typeExtends(release, type, conceptRequested.scheme)) return 'scheme';
  if (typeExtends(release, type, conceptRequested.type)) return 'concept';
  return undefined;
}

export function conceptCreateTypes(release: Release, locale: string): CreateType[] {
  return Object.keys(release.types)
    .filter((id) => conceptTypeAdmitted(release, id))
    .map((id) => {
      const definition = release.types[id]!;
      const labels = pickText(definition.labels ?? {}, locale);
      const descriptions = pickText(definition.descriptions ?? {}, locale);
      const bases = (definition.bases ?? []).filter((base) => typeof base === 'string' && base.length > 0);
      return {
        id,
        label: labels.text || id,
        description: descriptions.text,
        ...(labels.lang ? { labelLanguage: labels.lang } : {}),
        ...(descriptions.lang ? { descriptionLanguage: descriptions.lang } : {}),
        ...(bases.length ? { bases } : {}),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label, locale));
}

export function conceptPropertySupported(definition: Release['properties'][string] | undefined): boolean {
  if (!definition) return false;
  if (definition.datatype === 'wikibase-item') return !!definition.targets?.length && !!definition.relation;
  return editableScalar(definition);
}

/** Exact current Type properties; terms stay on the shared language rows, unsupported datatypes stay out. */
export function conceptCreateFields(release: Release, type: string): string[] {
  if (!conceptTypeAdmitted(release, type)) return [];
  const admitted = (release.types[type]?.properties ?? []).filter(
    (id) => !termProperties.has(id) && conceptPropertySupported(release.properties[id]),
  );
  const ranked = conceptRelationOrder.filter((id) => admitted.includes(id));
  return [...ranked, ...admitted.filter((id) => !ranked.includes(id as (typeof ranked)[number]))];
}

export function conceptTargetAdmitted(release: Release, property: string, type: string): boolean {
  const targets = release.properties[property]?.targets ?? [];
  return targets.some((target) => type === target || typeExtends(release, type, target));
}

export function conceptCreateEmptyFact(
  property: string,
  release: Release,
  key = crypto.randomUUID(),
): ConceptCreateFact {
  return { key, statement: emptyCreationStatement(property, release) };
}

export function canAddConceptFact(facts: readonly ConceptCreateFact[], property: string, release: Release): boolean {
  if (facts.length >= factLimit) return false;
  const definition = release.properties[property];
  if (!definition || !conceptPropertySupported(definition)) return false;
  const current = facts.filter((fact) => fact.statement.property.id === property).length;
  return definition.multivalued || current === 0;
}

export function conceptCreatePreparedFacts(facts: readonly ConceptCreateFact[], release: Release): ConceptCreateFact[] {
  return facts.flatMap((row) => {
    const statement = creationStatement(row.statement, release);
    return hasEnteredStatement(statement) ? [{ key: row.key, statement }] : [];
  });
}

export function conceptCreateDraft(
  release: Release,
  initial: InitialSubject,
  facts: readonly ConceptCreateFact[],
): { item: ConceptCreateItem; errors: Violation[] } {
  const item: ConceptCreateItem = { ...initial };
  const errors: Violation[] = [];
  const statements: Record<string, StatementInput[]> = {};
  for (const row of conceptCreatePreparedFacts(facts, release)) {
    const property = row.statement.property.id;
    (statements[property] ??= []).push(row.statement);
  }
  if (Object.keys(statements).length) item.statements = statements;
  errors.push(...checkSubjectInput(item, release).violations);
  if (!conceptTypeAdmitted(release, item.type)) errors.push({ pointer: '/type', code: 'unsupported' });
  const admitted = new Set(conceptCreateFields(release, item.type));
  for (const [property, rows] of Object.entries(statements)) {
    if (!admitted.has(property))
      errors.push({
        pointer: `/statements/${property.replaceAll('~', '~0').replaceAll('/', '~1')}`,
        code: 'unsupported',
      });
    rows.forEach((statement, index) => {
      if (statement.property.id !== property)
        errors.push({
          pointer: `/statements/${property.replaceAll('~', '~0').replaceAll('/', '~1')}/${index}`,
          code: 'invalid_format',
        });
      if (statement.rank !== 'normal')
        errors.push({
          pointer: `/statements/${property.replaceAll('~', '~0').replaceAll('/', '~1')}/${index}/rank`,
          code: 'unsupported',
        });
    });
  }
  return { item, errors };
}

export async function readConceptCreate(client: KernelClient): Promise<ConceptCreateRead> {
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

export function conceptAdmitCreatedReader(
  reader: CreatedReader,
  id: string,
  release: Release,
  type: string,
): CreatedReader {
  if (reader.state !== 'ready') return reader;
  const identity = reader.identity;
  if (!identity || identity.id !== id || identity.type !== type || !conceptTypeAdmitted(release, identity.type))
    return { state: 'stale' };
  return reader;
}

export async function createConceptSubject(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  command: CreateSubjectCommand,
  locale: string,
  preparedAuthorization?: string,
): Promise<CreateResult> {
  const read = await readConceptCreate(client);
  if (!read.ok) return { ok: false, reason: 'unavailable' };
  const statements = command.item.statements ?? {};
  if (command.item.statements !== undefined && !creationStatementMap(command.item.statements))
    return { ok: false, reason: 'invalid', errors: [{ pointer: '/statements', code: 'invalid_format' }] };
  const facts = Object.entries(statements).flatMap(([property, rows]) =>
    rows.map((statement, index) => ({ key: `${property}:${index}`, statement })),
  );
  const errors = conceptCreateDraft(read.release, command.item, facts).errors;
  if (errors.length) return { ok: false, reason: 'invalid', errors, refreshDefinitions: true };
  const created = await createSubjectRecord(client, request, sessionEnv, command, locale, preparedAuthorization);
  return created.ok
    ? {
        ...created,
        reader: conceptAdmitCreatedReader(created.reader, created.id, read.release, command.item.type),
      }
    : created;
}

export function conceptCreateHolder(key: string): string {
  return `concept-initial-${key}`;
}

export function conceptCreateHolders(facts: readonly ConceptCreateFact[]): ConceptCreateHolder[] {
  return facts.map((row) => ({ key: row.key, property: row.statement.property.id, statement: row.statement }));
}

export function conceptCreateFactDrafts(facts: readonly ConceptCreateFact[]): FactDraft[] {
  return facts.map((row) => ({
    holder: conceptCreateHolder(row.key),
    property: row.statement.property.id,
    source: null,
    baseline: null,
    statement: row.statement,
    included: true,
  }));
}

export function captureConceptCreateReuse(
  facts: readonly ConceptCreateFact[],
  key: string,
  groupIndex: number,
): ConceptCreateReuse | null {
  const row = facts.find((item) => item.key === key);
  const group = row && groupIndex >= 0 ? row.statement.references[groupIndex] : undefined;
  if (!row || !group) return null;
  const source = {
    holder: conceptCreateHolder(row.key),
    property: row.statement.property.id,
    groupIndex,
    snapshot: cloneReferenceGroup(group),
  };
  return {
    source,
    selected: [],
    capture: captureReuse(source, conceptCreateFactDrafts(facts)),
    applied: [],
    refused: [],
  };
}

export function applyConceptCreateReuse(
  facts: readonly ConceptCreateFact[],
  reuse: ConceptCreateReuse,
  release: Release,
): { facts: ConceptCreateFact[]; reuse: ConceptCreateReuse } {
  const result = applyReuse(conceptCreateFactDrafts(facts), reuse.source, reuse.selected, release);
  const byHolder = new Map(facts.map((row) => [conceptCreateHolder(row.key), row.key]));
  return {
    facts: result.drafts.flatMap((draft) => {
      const key = byHolder.get(factHolder(draft));
      return key ? [{ key, statement: draft.statement }] : [];
    }),
    reuse: { ...reuse, applied: result.applied, refused: result.refused },
  };
}

export function refreshConceptCreateReuse(
  facts: readonly ConceptCreateFact[],
  reuse: ConceptCreateReuse,
): ConceptCreateReuse | null {
  const row = facts.find((item) => conceptCreateHolder(item.key) === reuse.source.holder);
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
    capture: captureReuse(source, conceptCreateFactDrafts(facts)),
    applied: [],
    refused: [],
  };
}

export function conceptCreateUnsupported(item: ConceptCreateItem, release: Release): string[] {
  const admitted = new Set(conceptCreateFields(release, item.type));
  return Object.keys(item.statements ?? {}).filter((property) => !admitted.has(property));
}

export function conceptCreateStructuredParts(facts: readonly ConceptCreateFact[]): number {
  let count = 0;
  for (const row of facts) {
    count += 1 + (row.statement.qualifiers?.length ?? 0);
    for (const group of row.statement.references) count += group.parts.length;
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

function nestedControl(
  tail: string[],
  row: ConceptCreateHolder,
  release: Release,
  locale: string,
): { id: string; label: string } | undefined {
  const id = conceptCreateHolder(row.key);
  const o = { locale: locale as never };
  const label = pickText(release.properties[row.property]?.labels ?? {}, locale).text || row.property;
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

export function conceptCreateControl(
  pointer: string,
  captured: readonly ConceptCreateHolder[],
  facts: readonly ConceptCreateFact[],
  _type: string,
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
    m.concept_create_review_facts({}, { locale: locale as never });
  if (!property) return { id: factsId, label: fallback };
  const holders = captured.filter((holder) => holder.property === property);
  const ordinal = segments[2];
  if (ordinal === undefined) return { id: factsId, label: fallback };
  if (!/^(0|[1-9]\d*)$/.test(ordinal)) return;
  const index = Number(ordinal);
  const capturedRow = holders[index];
  const live = capturedRow && facts.find((row) => row.key === capturedRow.key);
  if (!capturedRow) return { id: factsId, label: fallback };
  if (!live || live.statement.property.id !== property)
    return { id: conceptCreateHolder(capturedRow.key), label: fallback };
  const nested = nestedControl(segments.slice(3), capturedRow, release, locale);
  return nested ?? { id: conceptCreateHolder(capturedRow.key), label: fallback };
}

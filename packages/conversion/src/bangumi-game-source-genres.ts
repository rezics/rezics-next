import { types as utilTypes } from 'node:util';
import type { BatchCommand, BatchReference, BatchStatement, Source } from '@rezics/definitions/bulk';
import { ConversionError, type ConversionDiagnostic } from './index.ts';
import {
  parseBangumiGameInfobox,
  type BangumiGameInfoboxField,
} from './bangumi-game-player-count.ts';
import { commandKey, reviewedReferenceKey, sourceEnvelope, type ConversionContext } from './support.ts';

export const bangumiGameSourceGenreScheme = 'https://rezics.com/schemes/bangumi/genres';
export const bangumiGameSourceGenreKey = '游戏类型';
export const bangumiGameSourceGenreOccurrenceLimit = 16;
const diagnosticLimit = 16;
const sourceValueLimit = 200;
const sourceValueBytes = 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type BangumiGameSourceGenreRequirement = Readonly<{
  literal: string;
  occurrence: number;
  pointer: string;
}>;

export type BangumiGameSourceGenreMapping = Readonly<{
  handledInfobox: boolean;
  requirements: readonly BangumiGameSourceGenreRequirement[];
  diagnostics: readonly ConversionDiagnostic[];
}>;

export type BangumiGameSourceGenreConversion = BangumiGameSourceGenreMapping & Readonly<{
  proposals: readonly Extract<BatchCommand, { op: 'propose' }>[];
}>;

function pointer(occurrence: number): string {
  return `/infobox/${bangumiGameSourceGenreKey}/${occurrence}`;
}

function addDiagnostic(diagnostics: ConversionDiagnostic[], item: ConversionDiagnostic): void {
  if (diagnostics.length < diagnosticLimit - 1) {
    diagnostics.push(item);
    return;
  }
  if (!diagnostics.some((entry) => entry.code === 'additional_infobox_omissions'))
    diagnostics.push({ pointer: '/infobox', code: 'additional_infobox_omissions' });
}

function structured(field: BangumiGameInfoboxField): boolean {
  return field.nested || field.continued || /[{}<>]/u.test(field.value);
}

/** Extract complete scalar occurrences from only the pinned type-4 Game template. */
export function bangumiGameSourceGenres(record: {
  readonly type: number;
  readonly infobox?: string;
}): BangumiGameSourceGenreMapping {
  if (record.type !== 4 || record.infobox === undefined)
    return { handledInfobox: false, requirements: [], diagnostics: [] };
  const parsed = parseBangumiGameInfobox(record.infobox);
  if (!parsed.matched) return { handledInfobox: false, requirements: [], diagnostics: [] };

  const diagnostics: ConversionDiagnostic[] = [];
  if (parsed.overflow) {
    addDiagnostic(diagnostics, { pointer: '/infobox', code: 'infobox_field_limit' });
    return { handledInfobox: true, requirements: [], diagnostics };
  }

  const requirements: BangumiGameSourceGenreRequirement[] = [];
  let occurrence = 0;
  for (const field of parsed.fields) {
    if (field.key !== bangumiGameSourceGenreKey) continue;
    const fieldOccurrence = occurrence++;
    const path = pointer(fieldOccurrence);
    if (fieldOccurrence >= bangumiGameSourceGenreOccurrenceLimit) {
      addDiagnostic(diagnostics, { pointer: path, code: 'game_genre_occurrence_limit' });
      break;
    }
    if (structured(field)) {
      addDiagnostic(diagnostics, { pointer: path, code: 'unsupported_game_genre_structure' });
      continue;
    }
    const literal = field.value.trim();
    if (!literal) {
      addDiagnostic(diagnostics, { pointer: path, code: 'empty_game_genre' });
      continue;
    }
    if (
      literal.length > sourceValueLimit ||
      Buffer.byteLength(literal, 'utf8') > sourceValueBytes ||
      !literal.isWellFormed() ||
      /[\u0000-\u001f\u007f]/u.test(literal)
    ) {
      addDiagnostic(diagnostics, { pointer: path, code: 'game_genre_value_limit' });
      continue;
    }
    requirements.push({ literal, occurrence: fieldOccurrence, pointer: path });
  }
  return { handledInfobox: true, requirements, diagnostics };
}

function resolvedConcept(
  references: Readonly<Record<string, string>> | undefined,
  reference: string,
): string | undefined {
  if (references === undefined) return undefined;
  if (typeof references !== 'object' || utilTypes.isProxy(references))
    throw new ConversionError('invalid_reference_context', '');
  const descriptor = Object.getOwnPropertyDescriptor(references, reference);
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor))
    throw new ConversionError('invalid_reference_context', '');
  const value: unknown = descriptor.value;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !uuid.test(value))
    throw new ConversionError('invalid_reference_context', '');
  return value;
}

/** Turn only caller-resolved, exact source bindings into ordinary cited Game proposals. */
export function convertBangumiGameSourceGenres(
  record: { readonly type: number; readonly infobox?: string },
  metadata: Pick<Source, 'source' | 'external_id' | 'record_revision' | 'converter_revision' | 'digest'>,
  recordUrl: string,
  context: Pick<ConversionContext, 'subjectId' | 'resolvedReferences'>,
): BangumiGameSourceGenreConversion {
  const mapping = bangumiGameSourceGenres(record);
  if (!mapping.handledInfobox || context.subjectId === undefined)
    return { ...mapping, proposals: [] };

  const source = sourceEnvelope(metadata, 'facts');
  const references: BatchReference[] = [
    {
      parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: recordUrl } }],
    },
  ];
  const proposals: Extract<BatchCommand, { op: 'propose' }>[] = [];
  const diagnostics = [...mapping.diagnostics];
  for (const requirement of mapping.requirements) {
    const reference = reviewedReferenceKey(bangumiGameSourceGenreScheme, requirement.literal);
    const concept = resolvedConcept(context.resolvedReferences, reference);
    if (!concept) {
      addDiagnostic(diagnostics, {
        pointer: requirement.pointer,
        code: 'missing_current_game_genre_binding',
      });
      continue;
    }
    const statement: BatchStatement = {
      property: { id: 'schema:genre' },
      value: { type: 'value', content: concept },
      references,
    };
    proposals.push({
      op: 'propose',
      key: commandKey([
        metadata.source,
        metadata.external_id,
        metadata.record_revision,
        metadata.digest,
        metadata.converter_revision,
        'facts',
        `bangumi-game-genre:${requirement.occurrence}:${requirement.literal}`,
        concept,
        context.subjectId,
      ]),
      source,
      subject: context.subjectId,
      statement,
    });
  }
  return { ...mapping, diagnostics, proposals };
}

export function bangumiGameSourceGenreReference(literal: string): string {
  return reviewedReferenceKey(bangumiGameSourceGenreScheme, literal);
}

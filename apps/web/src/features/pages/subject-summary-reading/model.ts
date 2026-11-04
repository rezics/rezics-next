import { pickLanguage } from '@rezics/composition';
import { originalLanguage } from '../../../subject/language';
import type { Subject } from '../../../subject/types';
import { bestRank, isRecord, type Stmt } from '../shared';

export const SUMMARY_PROPERTY = 'schema:abstract';
export const SUMMARY_CHOICE_METADATA_BYTE_CAP = 256 * 1024;
export const SUMMARY_CHOICE_ENTRY_CAP = 512;

const workTypes = new Set(['wd:Q689445', 'schema:Movie', 'schema:TVSeries', 'schema:Book']);

export type SynopsisChoice = {
  statement: Stmt;
  language: string;
  documentId?: string;
  digest?: string;
};

export type SynopsisChoiceSet =
  | { kind: 'not-admitted' }
  | { kind: 'none' }
  | { kind: 'unavailable'; reason: 'too-many' | 'too-large' | 'invalid' }
  | { kind: 'ready'; choices: SynopsisChoice[]; selectedId: string };

function languageTag(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 35) return false;
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

function snakMetadata(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.property) || !isRecord(value.value)) return null;
  return {
    property: {
      id: typeof value.property.id === 'string' ? value.property.id : '',
      data_type: typeof value.property.data_type === 'string' ? value.property.data_type : '',
    },
    value: {
      type: typeof value.value.type === 'string' ? value.value.type : '',
      ...(value.value.type === 'value' ? { content: value.value.content ?? null } : {}),
    },
  };
}

function validSnak(value: unknown): value is {
  id?: unknown;
  rank?: unknown;
  qualifiers?: unknown;
  references?: unknown;
  property: { id: string; data_type: string };
  value: { type: string; content?: unknown };
} {
  return (
    isRecord(value) &&
    isRecord(value.property) &&
    typeof value.property.id === 'string' &&
    typeof value.property.data_type === 'string' &&
    isRecord(value.value) &&
    ['value', 'somevalue', 'novalue'].includes(String(value.value.type))
  );
}

function choiceMetadata(statement: Stmt): unknown {
  return {
    id: statement.id,
    rank: statement.rank,
    value: snakMetadata(statement),
    qualifiers: statement.qualifiers.map(snakMetadata),
    references: statement.references.map((reference) => ({ parts: reference.parts.map(snakMetadata) })),
  };
}

/** Admit the entire disclosed work-synopsis projection before building language groups. */
export function synopsisChoices(subject: Subject, locale: string): SynopsisChoiceSet {
  if (!workTypes.has(subject.type)) return { kind: 'not-admitted' };
  const held = Object.hasOwn(subject.statements, SUMMARY_PROPERTY) ? subject.statements[SUMMARY_PROPERTY] : undefined;
  const statements = Array.isArray(held) ? (held as unknown as Stmt[]) : [];
  if (statements.length > SUMMARY_CHOICE_ENTRY_CAP) return { kind: 'unavailable', reason: 'too-many' };

  let metadata: string;
  let admitted: Stmt[];
  try {
    admitted = bestRank(statements);
    if (
      admitted.some((statement) => {
        const raw = statement as unknown;
        return (
          !validSnak(raw) ||
          typeof raw.id !== 'string' ||
          !/^[A-Za-z0-9:_-]{1,128}$/.test(raw.id) ||
          raw.property.id !== SUMMARY_PROPERTY ||
          raw.property.data_type !== 'document' ||
          !Array.isArray(raw.qualifiers) ||
          raw.qualifiers.some((qualifier) => !validSnak(qualifier)) ||
          !Array.isArray(raw.references) ||
          raw.references.some(
            (reference) =>
              !isRecord(reference) ||
              !Array.isArray(reference.parts) ||
              reference.parts.some((part) => !validSnak(part)),
          )
        );
      })
    )
      return { kind: 'unavailable', reason: 'invalid' };
    metadata = JSON.stringify(admitted.map(choiceMetadata));
  } catch {
    return { kind: 'unavailable', reason: 'invalid' };
  }
  if (new TextEncoder().encode(metadata).byteLength > SUMMARY_CHOICE_METADATA_BYTE_CAP)
    return { kind: 'unavailable', reason: 'too-large' };
  if (new Set(admitted.map((statement) => statement.id)).size !== admitted.length)
    return { kind: 'unavailable', reason: 'invalid' };

  const choices: SynopsisChoice[] = [];
  for (const statement of admitted) {
    const content = statement.value.type === 'value' ? statement.value.content : undefined;
    if (!isRecord(content)) continue;
    if (content.language === undefined) continue;
    if (!languageTag(content.language)) return { kind: 'unavailable', reason: 'invalid' };
    choices.push({
      statement,
      language: content.language,
      ...(typeof content.document === 'string' ? { documentId: content.document } : {}),
      ...(typeof content.digest === 'string' ? { digest: content.digest } : {}),
    });
  }
  if (!choices.length) return { kind: 'none' };
  const preferredLanguage = pickLanguage(
    choices.map((choice) => choice.language),
    locale,
    originalLanguage(subject),
  );
  const selected = choices.find((choice) => choice.language === preferredLanguage) ?? choices[0]!;
  return { kind: 'ready', choices, selectedId: selected.statement.id };
}

export function synopsisReturnMatches(
  choice: SynopsisChoice | undefined,
  descriptor: {
    candidateId: string;
    documentId: string;
    digest: string;
    language: string;
  },
): boolean {
  return !!(
    choice &&
    choice.statement.id === descriptor.candidateId &&
    choice.documentId === descriptor.documentId &&
    choice.digest === descriptor.digest &&
    choice.language === descriptor.language
  );
}

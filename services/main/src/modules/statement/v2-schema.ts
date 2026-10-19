import { InvalidContextCommand } from '../context/problems.ts';
import { checkedSemanticValue, type SemanticValue } from '../semantic/value.ts';
import type { Participant } from '../relation/schema.ts';
import { hash } from '../work/activate.ts';
import { normalizeStatementQualification, statementQualificationKeyTuple,
  type StatementQualification } from './qualification.ts';

export const STATEMENT_V2_PROFILE = 'https://rezics.com/definition/statement-v2';
export const OCCURRENCE_ASSERTION_NOTATION = 'association-occurrence-assertion-v1';
export type StatementCoverage =
  | { kind: 'participation'; occurrence: string; occurrenceRevision: string; participation: string }
  | { kind: 'occurrence'; occurrence: string; occurrenceRevision: string }
  | { kind: 'subject-global' };

/** These failures must survive the admitted-command wrapper without becoming a pending write. */
export class StatementV2Rejected extends InvalidContextCommand {
  constructor(readonly code: 'invalid_statement_coverage' | 'unsupported_model_revision' | 'generation_changed',
    message: string) { super(message); }
}

export const statementCoverageRejected = (message: string): never => {
  throw new StatementV2Rejected('invalid_statement_coverage', message);
};
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const statementNativeId = (value: unknown): value is string => typeof value === 'string' && native.test(value);

export function checkedStatementCoverage(input: unknown): StatementCoverage {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return statementCoverageRejected('coverage is required');
  const row = input as Record<string, unknown>;
  const fields = row.kind === 'participation' ? ['kind', 'occurrence', 'occurrenceRevision', 'participation']
    : row.kind === 'occurrence' ? ['kind', 'occurrence', 'occurrenceRevision']
    : row.kind === 'subject-global' ? ['kind'] : [];
  if (!fields.length || Object.keys(row).length !== fields.length || fields.some(field => !(field in row))
    || fields.some(field => field !== 'kind' && !statementNativeId(row[field]))) {
    return statementCoverageRejected('coverage must identify one exact participation, occurrence revision or subject-global meaning');
  }
  if (row.kind === 'subject-global') return { kind: 'subject-global' };
  const occurrence = row.occurrence as string, occurrenceRevision = row.occurrenceRevision as string;
  return row.kind === 'participation'
    ? { kind: 'participation', occurrence, occurrenceRevision, participation: row.participation as string }
    : { kind: 'occurrence', occurrence, occurrenceRevision };
}

export function checkedStatementParticipant(value: unknown): Participant {
  const subject = checkedSemanticValue(value);
  if (subject.kind !== 'resource' && subject.kind !== 'external') return statementCoverageRejected('subject must be a full native or qualified external Participant');
  return subject;
}

export interface StatementMeaningV2 {
  subject: Participant;
  predicate: string;
  relationDefinition: string;
  interpretationDefinitions: string[];
  value: SemanticValue;
  applicability: string[];
  coverage: StatementCoverage;
  qualification?: StatementQualification;
}

const references = (input: readonly string[], limit: number): string[] => {
  if (!Array.isArray(input) || input.length > limit || new Set(input).size !== input.length
    || input.some(ref => typeof ref !== 'string' || !/^https?:\/\/[^\s<>"{}|\\^`]{1,2040}$/.test(ref))) {
    return statementCoverageRejected('Statement references exceed the admitted bounds or are invalid');
  }
  return [...input].sort();
};

/** Allocated value-node IDs, speaker, evidence and acceptance never enter authored meaning. */
export function checkedStatementMeaningV2(input: StatementMeaningV2): StatementMeaningV2 {
  const coverage = checkedStatementCoverage(input.coverage);
  const subject = checkedStatementParticipant(input.subject);
  const value = checkedSemanticValue(input.value);
  if (coverage.kind === 'occurrence' && (subject.kind !== 'resource' || subject.ref !== coverage.occurrence
    || value.kind !== 'resource' || value.ref !== coverage.occurrenceRevision)) {
    return statementCoverageRejected('an occurrence assertion must name that exact occurrence and revision');
  }
  references([input.predicate, input.relationDefinition], 2);
  return { subject, predicate: input.predicate, relationDefinition: input.relationDefinition, value, coverage,
    applicability: references(input.applicability, 8), interpretationDefinitions: references(input.interpretationDefinitions, 8),
    ...(input.qualification ? { qualification: normalizeStatementQualification(input.qualification) } : {}) };
}

/** V1's unqualified and qualified domains retain their existing byte-for-byte meanings. */
export function statementMeaningKeyV2(input: StatementMeaningV2): string {
  const meaning = checkedStatementMeaningV2(input);
  return `urn:rezics:meaning:${hash(JSON.stringify(['statement-meaning-v3', meaning.subject, meaning.coverage,
    meaning.predicate, meaning.relationDefinition, meaning.value, meaning.applicability,
    meaning.interpretationDefinitions, meaning.qualification ? statementQualificationKeyTuple(meaning.qualification) : null]))}`;
}

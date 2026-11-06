/** Ordered occurrences and complete nested admission accounting. */

import type { NestedAdmissionAccount, NestedAdmissionTerm, OrderedOccurrence } from '../contract/index.ts';
import type { WorkDimensions } from '../contract/work-dimensions.ts';
import { zeroWorkDimensions } from './work-ledger.ts';

export function orderedOccurrences(
  rows: readonly Readonly<{
    occurrenceId: string;
    subjectId: string;
    ordinal: number;
    note?: string | null;
    duplicateOf?: string | null;
  }>[],
): readonly OrderedOccurrence[] {
  return Object.freeze(
    [...rows]
      .sort((left, right) =>
        left.ordinal === right.ordinal
          ? left.occurrenceId < right.occurrenceId
            ? -1
            : 1
          : left.ordinal - right.ordinal,
      )
      .map((row) =>
        Object.freeze({
          occurrenceId: row.occurrenceId,
          subjectId: row.subjectId,
          ordinal: row.ordinal,
          note: row.note ?? null,
          duplicateOf: row.duplicateOf ?? null,
        }),
      ),
  );
}

export function repeatedSubjectCount(occurrences: readonly OrderedOccurrence[]): number {
  const seen = new Map<string, number>();
  for (const row of occurrences) seen.set(row.subjectId, (seen.get(row.subjectId) ?? 0) + 1);
  return [...seen.values()].filter((count) => count > 1).reduce((sum, count) => sum + count, 0);
}

export function admissionTerm(name: string, dimensions: Partial<WorkDimensions> = {}): NestedAdmissionTerm {
  const zero = zeroWorkDimensions();
  return Object.freeze({
    name,
    candidateKeys: dimensions.candidateKeys ?? zero.candidateKeys,
    nativeRows: dimensions.nativeRows ?? zero.nativeRows,
    identityMetadataRows: dimensions.identityMetadataRows ?? zero.identityMetadataRows,
    emptySeeks: dimensions.emptySeeks ?? zero.emptySeeks,
    nativePoints: dimensions.nativePoints ?? zero.nativePoints,
    witnessKeys: dimensions.witnessKeys ?? zero.witnessKeys,
    statements: dimensions.statements ?? zero.statements,
    bytes: dimensions.bytes ?? zero.bytes,
  });
}

export function sumAdmission(terms: readonly NestedAdmissionTerm[]): NestedAdmissionAccount {
  return Object.freeze({
    terms: Object.freeze([...terms]),
    complete: terms.length > 0 && terms.every((term) => Number.isSafeInteger(term.nativeRows) && term.nativeRows >= 0),
  });
}

export function accountDimensions(account: NestedAdmissionAccount): WorkDimensions {
  const total = { ...zeroWorkDimensions() };
  for (const term of account.terms) {
    total.candidateKeys += term.candidateKeys;
    total.nativeRows += term.nativeRows;
    total.identityMetadataRows += term.identityMetadataRows;
    total.emptySeeks += term.emptySeeks;
    total.nativePoints += term.nativePoints;
    total.witnessKeys += term.witnessKeys;
    total.statements += term.statements;
    total.bytes += term.bytes;
  }
  return Object.freeze(total);
}

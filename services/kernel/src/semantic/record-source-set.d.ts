/** Adopted Semantic declaration only. The native implementation is supplied by its owner. */
import type { Pool } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import type { RecordHistorySourceReference } from '../history/record-source.ts';
declare const semanticSourceSet: unique symbol;
export type SemanticRecordSourceSet = Readonly<{ [semanticSourceSet]: true }>;
export type SemanticRecordSourceSetLocator = Readonly<{
  partition: number;
  transactionId: string;
  revision: number;
}>;
export type SemanticRecordSourceSetSnapshot = Readonly<{
  locator: SemanticRecordSourceSetLocator;
  digest: string;
  members: number;
}>;
export function beginSemanticRecordSourceSet(tx: CommandTransaction): Promise<SemanticRecordSourceSet>;
export function appendSemanticRecordSourceSet(
  tx: CommandTransaction,
  set: SemanticRecordSourceSet,
  input: Readonly<{
    sources: readonly RecordHistorySourceReference[];
    terms: readonly Readonly<{
      subjectId: string;
      originalRevision: number | null;
      currentRevision: number;
      field: 'labels' | 'descriptions' | 'aliases';
      language: string;
    }>[];
  }>,
): Promise<void>;
export function sealSemanticRecordSourceSet(tx: CommandTransaction, set: SemanticRecordSourceSet): Promise<void>;
export function semanticRecordSourceSetLocator(
  tx: CommandTransaction,
  set: SemanticRecordSourceSet,
): SemanticRecordSourceSetLocator;
export function readSemanticRecordSourceSet(
  deps: Readonly<{ pool: Pool; clock?: () => Date }>,
  locator: SemanticRecordSourceSetLocator,
  context: Readonly<{ deadline: number }>,
): Promise<SemanticRecordSourceSetSnapshot | null>;
export function verifySemanticRecordSourceSet(
  tx: CommandTransaction,
  locator: SemanticRecordSourceSetLocator,
  digest: string,
): Promise<boolean>;
export function pageSemanticRecordSourceSets(
  deps: Readonly<{ pool: Pool; clock?: () => Date }>,
  reference:
    | RecordHistorySourceReference
    | Readonly<{
        kind: 'terms';
        subjectId: string;
        revision: number;
        field: 'labels' | 'descriptions' | 'aliases';
        language: string;
      }>,
  options: Readonly<{ frontier: string | null; limit: number; deadline: number }>,
): Promise<
  Readonly<{
    state: 'progress' | 'complete';
    sets: readonly SemanticRecordSourceSetSnapshot[];
    frontier: string | null;
    examined: number;
  }>
>;

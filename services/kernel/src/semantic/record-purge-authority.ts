import type { Pool } from 'pg';
import type { CommandTransaction } from '../command/command.ts';

export type RecordPurgeReference = Readonly<{
  subjectId: string;
  candidateId: string;
  revision: number;
  documentId: string | null;
  deletionGeneration: string;
}>;

declare const recordPurgeAuthority: unique symbol;
export type RecordPurgeAuthority = { readonly [recordPurgeAuthority]: true };

export type RecordPurgeSource = Readonly<{
  reference: RecordPurgeReference;
  disposition: 'ordinary-deletion';
  sourceVersion: string;
  deletionTransactionId: string;
  deletionCommittedAt: string;
  purgeAfter: string;
}>;

// The source owner must replace these declarations' unavailable implementations
// with its native issuer and lifecycle locks. No authority is issued here.
export async function prepareRecordPurgeAuthority(
  _deps: Readonly<{ pool: Pool; clock?: () => Date }>,
  _reference: RecordPurgeReference,
  _context: Readonly<{ deadline: number }>,
): Promise<RecordPurgeAuthority | null> {
  throw new Error('Native record purge authority issuer unavailable');
}

export async function readRecordPurgeAuthoritySource(
  _deps: Readonly<{ pool: Pool; clock?: () => Date }>,
  _authority: RecordPurgeAuthority,
  _context: Readonly<{ deadline: number }>,
): Promise<RecordPurgeSource | null> {
  throw new Error('Native record purge authority source reader unavailable');
}

export async function lockRecordPurgeAuthoritySource(
  _tx: CommandTransaction,
  _authority: RecordPurgeAuthority,
): Promise<RecordPurgeSource | null> {
  throw new Error('Native record purge authority source lock unavailable');
}
